"use strict";

const crypto = require("node:crypto");

const PACKAGES = Object.freeze({
    Starter: 15000,
    Business: 35000,
});
const REFERENCE_LIFETIME_SECONDS = 2 * 60 * 60;

function sendJson(res, status, body) {
    res.status(status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
}

function paymentConfiguration() {
    const environment = process.env.MAESTRO_MPESA_ENV || "sandbox";
    const consumerKey = process.env.MAESTRO_MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MAESTRO_MPESA_CONSUMER_SECRET;
    const shortcode = process.env.MAESTRO_MPESA_SHORTCODE;
    const passkey = process.env.MAESTRO_MPESA_PASSKEY;
    const paymentUrl = process.env.MAESTRO_PAYMENT_PUBLIC_URL;
    const transactionType = process.env.MAESTRO_MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline";

    if (
        !["sandbox", "production"].includes(environment)
        || !consumerKey
        || !consumerSecret
        || !/^[0-9]{5,12}$/.test(shortcode || "")
        || !passkey
        || !["CustomerPayBillOnline", "CustomerBuyGoodsOnline"].includes(transactionType)
    ) {
        throw new Error("Daraja payment configuration is missing or invalid.");
    }

    const parsedPaymentUrl = parseHttpsUrl(paymentUrl);
    const publicSiteUrl = parseHttpsUrl(process.env.MAESTRO_PUBLIC_SITE_URL);
    if (!parsedPaymentUrl || !publicSiteUrl) {
        throw new Error("Public payment or website URL is missing or invalid.");
    }

    return {
        apiBase: environment === "production"
            ? "https://api.safaricom.co.ke"
            : "https://sandbox.safaricom.co.ke",
        consumerKey,
        consumerSecret,
        shortcode,
        passkey,
        transactionType,
        callbackUrl: `${paymentUrl.replace(/\/+$/, "")}?callback=1`,
        websiteOrigin: publicSiteUrl.origin,
    };
}

function parseHttpsUrl(value) {
    if (typeof value !== "string" || !value) {
        return null;
    }
    try {
        const url = new URL(value);
        if (
            url.protocol !== "https:"
            || !url.hostname
            || url.username
            || url.password
            || url.search
            || url.hash
        ) {
            return null;
        }
        return url;
    } catch {
        return null;
    }
}

function setCors(req, res, config) {
    const origin = req.headers.origin;
    if (origin !== config.websiteOrigin) {
        sendJson(res, 403, { message: "This payment request is not allowed." });
        return false;
    }

    res.setHeader("Access-Control-Allow-Origin", config.websiteOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
    return true;
}

async function darajaRequest(url, options, operation) {
    const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(25000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || typeof result !== "object") {
        const details = {};
        for (const key of ["errorCode", "errorMessage", "requestId", "ResponseCode", "ResponseDescription"]) {
            const value = result?.[key];
            if (typeof value === "string" || typeof value === "number") {
                details[key] = String(value).slice(0, 300);
            }
        }
        throw new Error(
            `${operation} returned HTTP ${response.status}.${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}`,
        );
    }
    return result;
}

async function accessToken(config) {
    const credentials = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
    const result = await darajaRequest(
        `${config.apiBase}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${credentials}`, Accept: "application/json" } },
        "Daraja OAuth",
    );
    if (typeof result.access_token !== "string" || !result.access_token) {
        throw new Error("Daraja did not return an access token.");
    }
    return result.access_token;
}

function nairobiTimestamp() {
    const values = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
            timeZone: "Africa/Nairobi",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
        }).formatToParts(new Date())
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value]),
    );
    return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

function signedReference(checkoutRequestId, packageName, amount, secret) {
    const payload = Buffer.from(JSON.stringify({
        checkoutRequestId,
        package: packageName,
        amount,
        expiresAt: Math.floor(Date.now() / 1000) + REFERENCE_LIFETIME_SECONDS,
    })).toString("base64url");
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}

function readReference(reference, secret) {
    if (typeof reference !== "string") {
        return null;
    }
    const [payload, signature, ...extra] = reference.split(".");
    if (
        !payload
        || !signature
        || extra.length
        || !/^[A-Za-z0-9_-]+$/.test(payload)
        || !/^[A-Za-z0-9_-]+$/.test(signature)
    ) {
        return null;
    }
    const expected = crypto.createHmac("sha256", secret).update(payload).digest();
    let supplied;
    try {
        supplied = Buffer.from(signature, "base64url");
    } catch {
        return null;
    }
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        return null;
    }

    try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (
            !claims
            || typeof claims.checkoutRequestId !== "string"
            || !/^[A-Za-z0-9_-]{1,100}$/.test(claims.checkoutRequestId)
            || !Object.hasOwn(PACKAGES, claims.package)
            || claims.amount !== PACKAGES[claims.package]
            || !Number.isInteger(claims.expiresAt)
            || claims.expiresAt < Math.floor(Date.now() / 1000)
        ) {
            return null;
        }
        return claims;
    } catch {
        return null;
    }
}

async function startPrompt(req, res, config) {
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > 4096) {
        return sendJson(res, 413, { message: "The payment request is too large." });
    }
    if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return sendJson(res, 415, { message: "Send the payment request as JSON." });
    }

    const { package: packageName, phone: phoneInput } = req.body || {};
    if (typeof packageName !== "string" || !Object.hasOwn(PACKAGES, packageName) || typeof phoneInput !== "string") {
        return sendJson(res, 400, { message: "Choose a supported package and enter a Kenyan phone number." });
    }

    const phone = phoneInput.replace(/[\s()-]/g, "");
    const normalizedPhone = /^0[17]\d{8}$/.test(phone)
        ? `254${phone.slice(1)}`
        : /^\+?254[17]\d{8}$/.test(phone)
            ? phone.replace(/^\+/, "")
            : null;
    if (!normalizedPhone) {
        return sendJson(res, 400, { message: "Enter a valid Kenyan mobile number, such as 0712345678 or +254712345678." });
    }

    const token = await accessToken(config);
    const timestamp = nairobiTimestamp();
    const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString("base64");
    const result = await darajaRequest(`${config.apiBase}/mpesa/stkpush/v1/processrequest`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({
            BusinessShortCode: config.shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: config.transactionType,
            Amount: PACKAGES[packageName],
            PartyA: normalizedPhone,
            PartyB: config.shortcode,
            PhoneNumber: normalizedPhone,
            CallBackURL: config.callbackUrl,
            AccountReference: "Maestro",
            TransactionDesc: packageName,
        }),
    }, "Daraja STK Push");

    if (
        String(result.ResponseCode) !== "0"
        || typeof result.CheckoutRequestID !== "string"
        || typeof result.MerchantRequestID !== "string"
    ) {
        console.error("Daraja did not accept the STK Push request.");
        return sendJson(res, 502, { message: "Daraja could not start the M-PESA prompt. Please try again shortly." });
    }

    return sendJson(res, 200, {
        reference: signedReference(result.CheckoutRequestID, packageName, PACKAGES[packageName], config.consumerSecret),
        message: "Check your phone and enter your M-PESA PIN to approve the payment.",
    });
}

async function checkStatus(req, res, config) {
    const reference = readReference(req.query.status, config.consumerSecret);
    if (!reference) {
        return sendJson(res, 400, { message: "The payment reference is invalid or has expired." });
    }

    const token = await accessToken(config);
    const timestamp = nairobiTimestamp();
    const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString("base64");
    const result = await darajaRequest(`${config.apiBase}/mpesa/stkpushquery/v1/query`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({
            BusinessShortCode: config.shortcode,
            Password: password,
            Timestamp: timestamp,
            CheckoutRequestID: reference.checkoutRequestId,
        }),
    }, "Daraja STK Push query");

    if (result.CheckoutRequestID !== reference.checkoutRequestId) {
        return sendJson(res, 502, { message: "Daraja returned a different payment reference." });
    }
    if (
        !(typeof result.ResultCode === "number" && Number.isInteger(result.ResultCode))
        && !(typeof result.ResultCode === "string" && /^\d+(?:\.\d+)*$/.test(result.ResultCode))
    ) {
        return sendJson(res, 502, { message: "Daraja returned an invalid payment status." });
    }
    const resultCode = Number(result.ResultCode);
    const description = String(result.ResultDesc || "").toLowerCase();
    const status = resultCode === 0
        ? "paid"
        : /being processed|still processing|pending/.test(description)
            ? "pending"
            : "failed";
    return sendJson(res, 200, {
        package: reference.package,
        amount: reference.amount,
        status,
    });
}

module.exports = async function paymentHandler(req, res) {
    let config;
    try {
        config = paymentConfiguration();
    } catch (error) {
        console.error("Maestro Daraja configuration is missing or invalid.");
        return sendJson(res, 503, { message: "M-PESA payments are not configured yet. Please contact us to arrange payment." });
    }

    const callback = req.query.callback === "1";
    if (callback) {
        if (req.method !== "POST") {
            res.setHeader("Allow", "POST");
            return sendJson(res, 405, { ResultCode: 1, ResultDesc: "POST required." });
        }
        const callbackBody = req.body;
        if (!callbackBody?.Body?.stkCallback?.CheckoutRequestID) {
            return sendJson(res, 400, { ResultCode: 1, ResultDesc: "Invalid callback." });
        }
        return sendJson(res, 200, { ResultCode: 0, ResultDesc: "Callback received." });
    }

    if (!setCors(req, res, config)) {
        return;
    }
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    try {
        if (req.method === "POST") {
            return await startPrompt(req, res, config);
        }
        if (req.method === "GET") {
            return await checkStatus(req, res, config);
        }
        res.setHeader("Allow", "GET, POST, OPTIONS");
        return sendJson(res, 405, { message: "Use the payment form to start or check a payment." });
    } catch (error) {
        console.error("Maestro Daraja request failed.", {
            name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : "Unknown error",
        });
        return sendJson(res, 502, { message: "The Daraja payment service is temporarily unavailable. Please try again later." });
    }
};
