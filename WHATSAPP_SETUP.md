# WhatsApp order list to the admin

Whenever a customer (signed-in or guest) places an order, the server sends the **ordered list to the
admin's WhatsApp number** - the customer does not receive it. Default admin number: **7483990595**
(change it with the optional Script Property `ADMIN_WHATSAPP`, 10 digits).
Admin e-mail: **Kamageremart04@gmail.com** (used as `ADMIN_EMAIL` unless you set that property yourself).
The first template variable {{1}} contains the customer's name, phone and delivery address.

Note: this uses Meta's **WhatsApp Business Cloud API**, the official way to send WhatsApp messages
from a program. The "Meta AI" chatbot cannot send messages and is not used.
If the settings below are missing, nothing is sent and ordering works exactly as before.

## 1. Set up Meta (one time, about 30 minutes)
1. Go to https://developers.facebook.com -> My Apps -> Create App -> type **Business** -> add the **WhatsApp** product.
2. WhatsApp -> **API Setup**. Copy the **Phone number ID** (not the phone number itself).
   - Meta gives a free *test* number. It can message only up to 5 numbers you add and verify under
     "To". To message real customers, add your store's own WhatsApp number (WhatsApp -> API Setup -> Add phone number)
     and complete Meta business verification.
3. Permanent token: business.facebook.com -> Business settings -> Users -> **System users** -> Add ->
   assign your app and WhatsApp account with full control -> **Generate new token** with permissions
   `whatsapp_business_messaging` and `whatsapp_business_management`. Copy it. (The 24-hour token on the API Setup page expires.)
4. Create the message template: https://business.facebook.com/wa/manage/message-templates -> **Create template**
   - Category: **Utility**
   - Name: `order_invoice`
   - Language: **English**
   - Body (copy exactly, the {{ }} parts are the 7 variables):

```
New order at Kamagere Mart! 🧾

Customer: {{1}}

Order {{2}}
Date: {{3}}
Items: {{4}}
Delivery charge: ₹{{5}}
Total amount: ₹{{6}}
Payment: {{7}}

Please confirm and deliver this order.
```
   - Sample values when Meta asks: Meena | Ph: 9000000000 | 12 MG Road / KM0172982 / 26/10/2026, 11:20:00 am / Aashirvaad Atta (5 kg) x 1 = Rs.285 / 0 / 285 / Cash on Delivery
   - Submit. Wait until the status shows **Active/Approved** (minutes to a day).

## 2. Put the settings in Apps Script
Project Settings (gear icon) -> Script Properties -> Add script property:

| Property | Value |
|---|---|
| WA_PHONE_NUMBER_ID | the Phone number ID from step 2 |
| WA_ACCESS_TOKEN | the permanent token from step 3 |
| WA_TEMPLATE_NAME | order_invoice |
| WA_TEMPLATE_LANG | en  (optional, default en) |
| ADMIN_WHATSAPP | 7483990595  (optional, this is the default) |
| WA_API_VERSION | v23.0  (optional; change if Meta retires that version) |

Never put the token in the code or in Git.

## 3. Deploy and test
1. Push/paste the new files, then Deploy -> Manage deployments -> pencil -> **New version** -> Deploy.
2. Log in as a customer, place an order. The admin number receives the order list; the customer's popup says "Your order list was sent to the store on WhatsApp".
3. The Orders sheet has a new column **invoiceStatus**: `Sent`, `Failed: ...` (reason from Meta),
   or `Not configured`.

## Good to know
- Meta charges per template message and the rules/prices change; check WhatsApp Manager -> Billing.
- The message is a text invoice. A PDF invoice would need a document template, which is not included.
- The admin number must have WhatsApp. While your Meta app is in test mode, add it to the allowed recipient list (API Setup -> To).
