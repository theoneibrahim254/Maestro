# Maestro enquiry and M-PESA setup

The public website is hosted on GitHub Pages. Daraja payments use a separate Vercel Node.js function; the Daraja consumer secret and passkey are never sent to the browser. The existing PHP/MySQL enquiry form is separate and is not used by checkout.

## 1. Deploy the Daraja API on Vercel

1. Import this repository into Vercel and set **Root Directory** to `maestro-api`.
2. Deploy once to obtain a public HTTPS domain. Vercel will expose the handler at `https://your-domain.example/api/payment`.
3. In **Project Settings → Environment Variables**, set the following values for the same environment:

| Variable | Purpose |
| --- | --- |
| `MAESTRO_PUBLIC_SITE_URL` | GitHub Pages HTTPS origin, e.g. `https://theoneibrahim254.github.io` |
| `MAESTRO_PAYMENT_PUBLIC_URL` | Exact public function URL, e.g. `https://your-domain.example/api/payment` |
| `MAESTRO_MPESA_ENV` | `sandbox` for testing; `production` after Safaricom enables your app |
| `MAESTRO_MPESA_CONSUMER_KEY` | Private Daraja app consumer key |
| `MAESTRO_MPESA_CONSUMER_SECRET` | Private Daraja app consumer secret |
| `MAESTRO_MPESA_SHORTCODE` | Safaricom-issued paybill or till shortcode |
| `MAESTRO_MPESA_PASSKEY` | Private Daraja Lipa na M-PESA passkey |
| `MAESTRO_MPESA_TRANSACTION_TYPE` | Optional: `CustomerPayBillOnline` (default) or `CustomerBuyGoodsOnline` for a till |

Use the matching sandbox or production app credentials, shortcode, and passkey. `MAESTRO_PAYMENT_PUBLIC_URL` is also used to form the Daraja callback URL by appending `?callback=1`.

Never put Daraja credentials in HTML, GitHub Pages variables, Git, or chat. Configure them only as private Vercel environment variables. Redeploy after changing environment variables.

## 2. Connect GitHub Pages to the payment endpoint

1. In GitHub, open **Settings → Secrets and variables → Actions → Variables**.
2. Add the repository variable `MAESTRO_PAYMENT_URL` with the exact public URL from Vercel, such as `https://your-domain.example/api/payment`. This endpoint URL is public and is not a credential.
3. Run **Deploy Maestro preview to GitHub Pages** from the **Actions** tab. Payment checkout remains disabled until this deployment publishes the endpoint URL in the page.

## 3. Test the payment flow

1. Keep `MAESTRO_MPESA_ENV=sandbox` and use Daraja sandbox test credentials and test numbers.
2. Choose Starter or Business, enter a Kenyan mobile number, then approve the matching prompt with the M-PESA PIN.
3. The server verifies payment status using Daraja's STK Push query API. A request being sent or a prompt appearing on the phone does not mean payment is complete.
4. Only after successful sandbox testing and Safaricom approval, switch to production credentials and `MAESTRO_MPESA_ENV=production`.

The server-side package amounts are KES 15,000 for Starter and KES 35,000 for Business; Advanced remains enquiry-only until quoted. Payment references are signed and expire after two hours. This integration does not save orders or receipts in a database and does not provide durable rate limiting. Add persistent order storage, reconciliation, and provider-level rate limiting before relying on payments for automated fulfillment.
