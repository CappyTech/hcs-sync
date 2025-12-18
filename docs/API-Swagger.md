KashFlow REST API (v1 on base /v2)
=================================

Base URL: `https://api.kashflow.com/v2`

Purpose
-------
Concise, human‑readable index of KashFlow REST endpoints extracted from the original Swagger dump. Each resource group lists HTTP method, path, and a brief description. (Original verbose markers like "Show/HideList Operations" removed.)

Legend: `GET` read, `POST` create/action, `PUT` update, `DELETE` delete.

Model Coverage Legend
---------------------
`[MODELED]` We have an internal Mongoose model for this resource.
`[PARTIAL]` Only part of the resource family is modeled.
`[NONE]` No direct model (default; omitted tag).

Mapped Models (path → resource):
- `mongoose/models/mongoose/REST/customer.js` → Customers
- `mongoose/models/mongoose/REST/invoice.js` → Invoices
- `mongoose/models/mongoose/REST/purchase.js` → Purchases
- `mongoose/models/mongoose/REST/project.js` → Projects
- `mongoose/models/mongoose/REST/quote.js` → Quotes
- `mongoose/models/mongoose/REST/supplier.js` → Suppliers
- `mongoose/models/mongoose/REST/nominal.js` → Nominals

Table of Contents
-----------------
1. Accounting Periods
2. Account Summary
3. Address Finder
4. Advance Payment
5. Reports (Aged Creditors / Debtors / Balance Sheet / Profit & Loss / Trial Balance / Year End / VAT / MOSS / Business / Nominal Ledger / Management / Sales / Purchase)
6. Alerts & Notifications (AlertMessage, Dashboard Overview)
7. Amazon File Migration
8. Authentication / Session Tokens
9. Backup
10. Bank (Accounts, Feeds, Icons, Reconciliation, Transactions, MatchingEngine)
11. Branding
12. Bulk Operations (Documents, Email, Payment)
13. Business Sources
14. Card & Cardless Payments
15. Categories & Category Icons (Quote / Purchase Order)
16. Company Details / Company House
17. Copy Object
18. Country & VAT Rates
19. Credit (Advance/Over/Credit Notes)
20. Currencies
21. Customers (Core, Statistics, Statements, Recurring Invoices, Mandates) [MODELED]
22. Customer & Supplier Settings
23. Customer Transactions
24. Dashboard (Widgets, Layout, Summary, Settings)
25. Data Import
26. Duplicate Entity
27. ECSL
28. Email (Send, Options, Templates, Logs, Substitutions)
29. Expenses
30. Feature Switch / Feature Value
31. Files / Dropbox
32. Fixed Asset Register
33. GoCardless Integration
34. Help & Support
35. Help Content
36. In‑App Purchases (iOS)
37. Integrations & Settings
38. Invoices (Core, Recurring, Refund, Reminder Letters) [MODELED]
39. ITSA (Businesses, Periods, Periodic Updates, Calculations, Losses, Obligations, Submissions)
40. Journals & Templates
41. JS Error Logging
42. Login Log
43. Mail Timeline
44. Management Report
45. Metadata
46. Mileage (Settings, Trips, Employees)
47. Next Available Numbers
48. Nominals [MODELED]
49. Notes [MODELED]
50. OAuth / Signed URI
51. OCR File
52. Partner
53. Password
54. Payment Method / Processor / Status / Unallocation / PayOnline
55. Payroll Activation
56. Permalink (Documents/PDF)
57. Product
58. Projects [MODELED]
59. Promo / Subscription
60. Purchases & Purchase Orders (Core, Recurring) [PARTIAL]
61. Purchase Reports & Settings
62. Quote & Quote Categories / Reports [MODELED]
63. Receipt Bank Integration
64. Recurring (Bank Transactions / Invoices / Purchases)
65. Referral
66. Reports Settings / Cache / Cover Sheet
67. Roles
68. Sales Agent
69. Search
70. Self Assessment Tax
71. SendGrid Webhook
72. Settings (General, VAT, Profile, Mileage, API, etc.)
73. Signup
74. SMTP Config & OAuth
75. Stock Options
76. Suppliers (Core, Statistics, Transactions, Recurring Purchases) [MODELED]
77. Tax (General)
78. Trips
79. Users (Additional Users)
80. VAT (Returns, Liability, MOSS, Submission Gateway, Settings)
81. ViaPost
82. Withholding Tax Deduction

------------------------------------------------------------
1. Accounting Periods
------------------------------------------------------------
GET `/accountingperiods` List accounting periods.
POST `/accountingperiods` Create accounting period.
DELETE `/accountingperiods/{id}` Delete period by ID and subsequent years.

2. Account Summary
GET `/accountsummary` Dashboard display and widget settings.

3. Address Finder
GET `/postcodes/{postcode}` Address list for postcode.

4. Advance Payment
GET `/customers/{code}/advancepayments` Customer advance payments.
GET `/suppliers/{code}/advancepayments` Supplier advance payments.

5. Reports (Selected Groups)
5.1 Aged Creditors: GET `/reports/agedcreditors`
5.2 Aged Debtors: GET `/reports/ageddebtors`
5.3 Balance Sheet: GET `/reports/balancesheet`
5.4 Profit & Loss: GET `/reports/profitandloss` ; Monthly: `/reports/profitandloss/monthly-profit-loss(-csv)`
5.5 Trial Balance: GET `/reports/trialbalance` ; first transaction date `/reports/trialbalance/firsttransactiondate`
5.6 Year End: POST `/reports/yearend` ; POST `/reports/yearend/nominalcode`
5.7 VAT (selected): see section 80.
5.8 MOSS: GET `/reports/vatmoss` etc (see VAT section).
5.9 Business Activity: various under `/reports/business/*`
5.10 Nominal Ledger: POST `/reports/nominalledger/guid`
5.11 Management: GET `/reports/managementreport` ; POST create.
5.12 Sales: multiple `/reports/sales/*` endpoints.
5.13 Purchase: multiple `/reports/purchase/*` endpoints.

6. Alerts & Notifications
PUT `/alert/{messageId}` Mark alert read + unread list.
GET `/dashboard/overview/notifications` Alerts.
GET `/dashboard/overview/announcements` Partner announcements.
GET `/dashboard/overview/referrals` Referral details.
GET `/dashboard/overview/onboarders` Onboarders.

7. Amazon File Migration
PUT `/internal/amazonfiles/migration` Move files Amazon→Dropbox.

8. Authentication / Session Tokens
GET `/sessiontoken` Auto login usage.
GET `/sessiontoken/{id}` Create permanent link.
GET `/sessiontoken/dext/{oauthToken}` Validate Dext token.
POST `/sessiontoken` Request temporary token.
POST `/sessiontoken/mobile` Create mobile session token.
PUT `/sessiontoken` Generate permanent token.
DELETE `/sessiontoken/{sessionToken}` Delete token.

Authentication Flow (KF Session Token)
-------------------------------------
1. Temporary Token Request: `POST /sessiontoken`
	- Provide primary credentials (e.g. username + password or password + selected memorable word characters as required by account policy).
	- Response includes a short‑lived temporary session token (TemToken) and the positions of memorable word characters still needed if using 2‑step verification.
2. Permanent Token Generation: `PUT /sessiontoken`
	- Send the temporary token plus the requested memorable word characters (or second factor) to promote the temporary token to a permanent KF session token (`KFSessionToken`).
	- If characters are incorrect or expired, endpoint returns an error; re‑initiate step 1.
3. Optional Permanent Link: `GET /sessiontoken/{id}`
	- Creates or retrieves a permanent login link bound to the session token for deep‑link auto login scenarios (e.g. emailed links or embedded portal redirects).
4. Mobile Session: `POST /sessiontoken/mobile`
	- Issues a session token tailored for mobile client usage; lifecycle and privileges may differ (reduced scope/expiration).
5. Third‑Party Validation: `GET /sessiontoken/dext/{oauthToken}`
	- Confirms that the current logged‑in user context is valid for an external integration token (e.g. Dext); does not itself mint KF session tokens.
6. Revocation / Logout: `DELETE /sessiontoken/{sessionToken}`
	- Immediately invalidates the permanent token; clients must discard local storage/cache.

Usage in Subsequent Requests:
- Include the KF session token in an authenticated request header. Common patterns (confirm in live environment):
  - `Authorization: Bearer <KFSessionToken>` or
  - `X-SessionToken: <KFSessionToken>`
  (Exact header name depends on deployment; inspect actual API responses or integration guides to confirm.)
- Token grants access according to the user’s role/permissions; expired or revoked tokens return an authorization error (typically 401/403).

Security Considerations:
- Temporary token has a brief TTL; do not persist it.
- Always transmit over HTTPS; never log memorable word characters.
- Rotate or revoke tokens on user password change or suspected compromise.
- Avoid embedding permanent links in publicly accessible locations; they should be treated as secrets.

Error Handling Tips:
- Invalid memorable word characters: repeat step 1 to obtain a fresh temporary token before retrying.
- Expired token: 401 response; initiate new flow.
- Revoked token: DELETE endpoint already used or admin action; prompt re-authentication.

Minimal Pseudocode Example:
```
// Step 1: request temporary token
POST /sessiontoken { username, password }
-> { tempToken, requiredChars: [2,5] }

// Collect memorable word characters positions 2 & 5, then:
PUT /sessiontoken { tempToken, chars: {2:'A',5:'R'} }
-> { sessionToken: 'KF_abc123...', expiresAt: '2025-11-30T12:00:00Z' }

// Use sessionToken for authenticated calls
GET /invoices { headers: { Authorization: 'Bearer KF_abc123...' } }
```

If the deployment uses a different header (e.g. `X-KF-SessionToken`), adjust the request header accordingly.

9. Backup
GET `/backup/{backupNumber}` Download backup file.

10. Bank
10.1 Accounts: CRUD under `/bankaccounts` (+ suggested code, feeds, associate, order).
10.2 Feeds: `/bankfeeds` list, transactions, create, delete.
10.3 Icons: GET `/bankicons`
10.4 Reconciliation: endpoints under `/bankaccounts/{bankaccountId}/reconciliations`
10.5 Transactions: CRUD under `/bankaccounts/{accountId}/transactions` plus bulk assign/list.
10.6 MatchingEngine: import draft & transactions under `/matchingengine/import/*`

11. Branding
GET `/branding` User branding settings.

12. Bulk Operations
Documents: POST `/documents/{type}/bulk`
Email: POST bulk endpoints (`/invoices/bulk/email`, etc.)
Payment: GET/POST/PUT/DELETE `/{objectType}/bulk/payments(/ {number})`

13. Business Sources
GET `/sources` List. GET `/sources/getSource` by name. CRUD via `/sources/{id}` etc.

14. Card & Cardless Payments
POST `/internal/cardlesspayments` Cardless payment.
Card: `/internal/cardpayments` (+ processorType routes, refund).

15. Categories & Icons
Quote Categories: `/quotecategories` CRUD & bulk.
Purchase Order Categories: `/purchaseordercategories` CRUD & bulk.
Icons: GET `/categoryicons`

16. Company Details / Company House
Company details & lists: `/settings/companydetails*`
GET `/companieshouse/companies` Company House lookup.

17. Copy Object
POST `/copy` Copy invoice/quote.

18. Country & VAT Rates
GET `/countries` List. GET `/countries/vatrates` VAT rates.

19. Credit
GET/POST `/internal/{objectType}/{objectId}/credits`

20. Currencies
Full CRUD under `/currencies`.

21. Customers
List/search/statistics/standing orders: various `/customers/*` endpoints.
CRUD `/customers/{code}`.
Bulk operations + schedule statement + valid-email.
Mandates under `/customers/{customerCode}/mandates*`
Recurring invoices under `/recurringinvoices` & by customer.

22. Customer & Supplier Settings
GET/PUT `/settings/customerandsupplier`

23. Customer Transactions
GET `/customers/{code}/transactions` ; `/customerstatementtransaction`

24. Dashboard
Widgets: `/dashboard/widgets*`
Overview: `/dashboard/overview/*`
Summary: `/dashboard/summary/*`
Settings: `/dashboard/settings/display`

25. Data Import
POST `/dataimport` Queue PayPal import.

26. Duplicate Entity
POST `/duplicate` Copy invoice/quote.

27. ECSL
GET/PUT `/ecsl/{vatReturnId}/vaterrors`

28. Email
Send: POST `/email`
Options: GET/PUT `/emailoptions`
Templates: `/emailtemplates*`
Logs: GET `/reports/emaillog`
Substitutions: GET `/{objectType}/{number}/emailtextsubstitutions`

29. Expenses
CRUD `/expenses` + articles.

30. Feature Switch / Value
GET `/FeatureSwitch/{switchName}` ; GET `/FeatureValue/{valueName}`

31. Files / Dropbox
Entity files: `/ {objectType}/{objectNumber}/files` + single file.
Dropbox auth/account operations under `/dropbox/*`

32. Fixed Asset Register
Category, asset, pending asset, reports under `/fixedassetregister/*`

33. GoCardless Integration
Connect/login/status/access_token/webhook/disconnect under `/gocardless/*`

34. Help & Support
Support access + Zendesk ticket under `/help/*`

35. Help Content
GET `/helpcontent/{helpcontentId}`

36. In‑App Purchases (iOS)
POST/PUT `/iap/receipts`

37. Integrations & Settings
List `/integrations` ; remove GoCardless; settings for receiptbank.

38. Invoices
CRUD `/invoices` + assign project, email count, archive, convert quotes.
Refund: POST `/internal/invoices/refund/baddebt`
Reminder letters endpoints under `/reminderletters` & `/invoices/{invoicenumber}/reminderletters*`
Recurring invoices: `/recurringinvoices*`

39. ITSA
Businesses, periods, periodic updates, tax calculations, losses, obligations, submission gateway endpoints under `/itsa/*`

40. Journals & Templates
CRUD `/journals` & `/journals/template`

41. JS Error Logging
POST `/jserror`

42. Login Log
GET `/reports/loginlog`

43. Mail Timeline
GET `/mailtimeline`

44. Management Report
GET/POST `/reports/managementreport`

45. Metadata
GET `/metadata`

46. Mileage
Settings & lookups: `/mileage/*` (enginesizes, vehicletypes, employee CRUD, trips CRUD, overview).

47. Next Available Numbers
GET `/nextavailable(invoicenumber|projectnumber|purchasenumber|quotenumber|purchaseordernumber)`

48. Nominals
List, details, SA103 mapping, create, update, delete, special/discount nominal.

49. Notes
CRUD `/{objectType}/{objectNumber}/notes`

NoteShow/HideList OperationsExpand Operations
get /{objectType}/{objectNumber}/notesGet a list of notes for an object, such as Customer or Supplier
Response Class (Status 200)
ModelModel Schema
[
  {
    "Number": 0,
    "Text": "string",
    "Date": "string",
    "LastModifiedBy": "string"
  }
]


Response Content Type 
application/json
Parameters
Parameter	Value	Description	Parameter Type	Data Type
objectNumber	
(required)
Is the Number of the above Object Type, used to identify the above object

path	string
objectType	
1
Is the Type of Object i.e Invoice,Quote,Customer etc 1 = Customers, 2 = Suppliers, 3 = Invoices, 4 = Quotes, 5 = Purchases, 6 = PurchaseOrders

path	integer
Response Messages
HTTP Status Code	Reason	Response Model	Headers
400	Invalid parameters	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
401	Unauthorized Access	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
404	Entity not found	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
get /{objectType}/{objectNumber}/notes/{number}Get note details, by object and ID
Response Class (Status 200)
ModelModel Schema
{
  "Number": 0,
  "Text": "string",
  "Date": "string",
  "LastModifiedBy": "string"
}


Response Content Type 
application/json
Parameters
Parameter	Value	Description	Parameter Type	Data Type
objectNumber	
(required)
Is the Number of the above Object Type, used to identify the above object

path	string
number	
(required)
Is the Number of the Note to be fetched

path	integer
objectType	
1
Is the type of Note object i.e Invoice,Quote,Customer etc 1 = Customers, 2 = Suppliers, 3 = Invoices, 4 = Quotes, 5 = Purchases, 6 = PurchaseOrders

path	integer
Response Messages
HTTP Status Code	Reason	Response Model	Headers
400	Invalid parameters	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
401	Unauthorized Access	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
404	No note found		
post /{objectType}/{objectNumber}/notesCreate a note for an object, such as Customer or Supplier
Response Class (Status 200)
ModelModel Schema
{}


Response Content Type 
application/json
Parameters
Parameter	Value	Description	Parameter Type	Data Type
objectNumber	
(required)
Is the Number of the above Object Type, used to identify the above object

path	string
noteBase	
(required)

Parameter content type: 
application/json
Note details

body	
ModelModel Schema
{
  "Text": "string"
}
Click to set as parameter value
objectType	
1
Is the Type of Object i.e Invoice,Quote,Customer etc 1 = Customers, 2 = Suppliers, 3 = Invoices, 4 = Quotes, 5 = Purchases, 6 = PurchaseOrders

path	integer
Response Messages
HTTP Status Code	Reason	Response Model	Headers
201	Created	
ModelModel Schema
{
  "Number": 0,
  "Text": "string",
  "Date": "string",
  "LastModifiedBy": "string"
}
400	Invalid parameters	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
401	Unauthorized Access	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
404	Entity not found	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
put /{objectType}/{objectNumber}/notes/{number}Update a note for an object, such as Customer or Supplier
Response Class (Status 200)
ModelModel Schema
{
  "Number": 0,
  "Text": "string",
  "Date": "string",
  "LastModifiedBy": "string"
}


Response Content Type 
application/json
Parameters
Parameter	Value	Description	Parameter Type	Data Type
objectNumber	
(required)
Is the Number of the above Object Type, used to identify the above object

path	string
number	
(required)
Is the Number of the Note to be Updated

path	integer
noteRequest	
(required)

Parameter content type: 
application/json
Note details to be updated

body	
ModelModel Schema
{
  "Number": 0,
  "Text": "string"
}
Click to set as parameter value
objectType	
1
Is the Type of Object i.e Invoice,Quote,Customer etc 1 = Customers, 2 = Suppliers, 3 = Invoices, 4 = Quotes, 5 = Purchases, 6 = PurchaseOrders

path	integer
Response Messages
HTTP Status Code	Reason	Response Model	Headers
400	Invalid parameters	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
401	Unauthorized Access	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
404	No note found		
delete /{objectType}/{objectNumber}/notes/{number}Delete a note for an object, such as Customer or Supplier
Response Class (Status 200)
ModelModel Schema
{}


Response Content Type 
application/json
Parameters
Parameter	Value	Description	Parameter Type	Data Type
objectNumber	
(required)
Is the Number of the above Object Type, used to identify the above object

path	string
number	
(required)
Is the Number of the Note to be Deleted

path	integer
objectType	
1
Is the Type of Object i.e Invoice,Quote,Customer etc

path	integer
Response Messages
HTTP Status Code	Reason	Response Model	Headers
204	Note deleted		
400	Invalid parameters	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
401	Unauthorized Access	
ModelModel Schema
{
  "Message": "string",
  "Error": "string"
}
404	No note found		


50. OAuth / Signed URI
GET `/okta/oauth-url` ; GET `/irisoauth/accesstoken` ; GET `/oauthsigneduri`

51. OCR File
GET `/ocr/file/extraction-detail`

52. Partner
GET `/partners/{partnerId}` ; `/partners/{partnerId}/rsrcssdetails`

53. Password
Reset, breach check, change password endpoints under `/password*`

54. Payment Related
Method: GET `/paymentmethods/{type}`
Processor: `/paymentprocessors*` CRUD & authorize.
Status: GET `/paymentstatuses`
Unallocate: POST `/internal/{objectType}/{number}/payments/{paymentId}/unallocate`
PayOnline: `/payonline/*` info, worldpay secrets, payment submit.

55. Payroll Activation
POST `/internal/payrollactivation`

56. Permalink / Documents
GET `/documents/{documentType}/{id}` single PDF; bulk; invoice/purchase payment PDFs.

57. Product
CRUD `/products` + by nominal code.

58. Projects
List/search CRUD `/projects` ; by customer.

59. Promo / Subscription
Promo code endpoints `/subscription/promo` ; subscription CRUD & details `/subscription*`

60. Purchases & Purchase Orders
Purchases: CRUD `/purchases` + reverse, bulk create, assign project, email flag.
Purchase Orders: CRUD `/purchaseorders` + email flag.
Recurring Purchases: `/recurringpurchases*`

61. Purchase Reports & Settings
Settings: `/settings/purchaseorder`
Reports: `/reports/purchase/*`

62. Quotes & Categories / Reports
Quotes CRUD `/quotes` ; categories `/quotecategories*` ; report `/reports/quotes`

63. Receipt Bank Integration
POST `/integrations/receiptbank`

64. Recurring Bank Transactions / Invoices / Purchases
Endpoints under `/recurringbanktransaction*`, `/recurringinvoices*`, `/recurringpurchases*`

65. Referral
POST `/referral/code`

66. Reports Settings / Cache / Cover Sheet
Settings: GET/PUT `/reports/settings`
Cache: DELETE `/reportcache`
Cover Sheet: GET `/reports/coversheet`

67. Roles
GET `/roles`

68. Sales Agent
Multiple POST endpoints `/salesagent/*` (createcustomer, chargecard, etc.)

69. Search
GET `/search`

70. Self Assessment Tax
GET `/tax/selfassessment`

71. SendGrid Webhook
POST `/sendgridwebhook`

72. Settings (General/VAT/Profile/Mileage/API/etc.)
Core: `/settings` variants (invoice, project, quote, user, referral, api, profile, mileage, termsandconditions, gocardless, pdfthemes, menu, advanced).

73. Signup
Endpoints `/signups*` for activation and user creation.

74. SMTP Config & OAuth
SMTP: GET/PUT/DELETE `/SMTPConfig`
OAuth: `/SMTPOAuth/*` authurl, accesstoken, disconnect.

75. Stock Options
GET/PUT `/stockoptions`

76. Suppliers
CRUD `/suppliers` + statistics, confirm delete, suggested code, valid-email, archive; recurring purchases by supplier code.
Transactions: `/suppliers/{code}/transactions`

77. Tax (General)
GET `/taxes`

78. Trips
CRUD `/mileage/trips*` + cost and overview.

79. Users (Additional Users)
CRUD `/users` + activation email, credential update, legacy check.

80. VAT
Returns CRUD `/vatreturns*` (details, summary, submit, paidstatus, markasopen) + years/summary.
Liability: GET `/vatliability`
MOSS returns under `/reports/vatmoss*`
Submission Gateway: `/vatsubmissiongateway/*` auth_url, accesstoken, disconnect.
Settings: various under `/settings/vat*` and `/vat/settings*`

81. ViaPost
GET `/viapost/balance` ; POST `/viapost`

82. Withholding Tax Deduction
POST `/internal/{objectType}/{objectNumber}/withholdingtaxdeduction`

Notes & Empty Models
--------------------
Many endpoints respond with structured JSON objects; the original Swagger excerpt ended with an empty model schema for status 200 in one section. Refer to official Swagger UI for full schemas when implementing integrations requiring precise field validation.

Reference
---------
Original Swagger UI: https://api.kashflow.com/v2/swagger/ui/index

Change Log (Local Doc)
----------------------
2025-11-25 Reformatted dense Swagger dump into structured index for developer readability.


KashFlow.RestApi
AccountingPeriodShow/HideList OperationsExpand Operations
get /accountingperiodsThis API allows a developer to retrieve a list of accounting periods available in specific IRIS KashFlow account.
post /accountingperiodsThis API allows a developer to create a new accounting period.
delete /accountingperiods/{id}This API allows developer to delete existing accounting period(s) with given ID and all the years after given ID.
AccountSummaryShow/HideList OperationsExpand Operations
get /accountsummaryGet display settings and dashboard widget details
AddressFinderShow/HideList OperationsExpand Operations
get /postcodes/{postcode}Returns the list of addresses for a postcode.
AdvancePaymentShow/HideList OperationsExpand Operations
get /customers/{code}/advancepaymentsGet the advance payment list for a customer, by code
get /suppliers/{code}/advancepaymentsGet the advance payment list for a supplier, by code
AgedCreditorsReportShow/HideList OperationsExpand Operations
get /reports/agedcreditorsThis API allows a developer to get age creditors report. The Aged Creditors report is used to view the amount of money that you owe to, or are owed by, your suppliers (also known as creditors) until a specific date. It will display the current balance you owe and the historical balance over the last three months and beyond.
AgedDebtorsReportShow/HideList OperationsExpand Operations
get /reports/ageddebtorsThis API allows a developer to get age debtors report. The Aged Debtors report is used to view the amount of money that you owe to, or are owed by, your customers (also known as debtors) until a specific date. It will display the current balance you owe and also the historical balance over the last three months and beyond.
AlertMessageShow/HideList OperationsExpand Operations
put /alert/{messageId}Mark an alert as read and get a list of unread alerts
AmazonFileShow/HideList OperationsExpand Operations
put /internal/amazonfiles/migrationMove files from Amazon to Dropbox
AuthenticationShow/HideList OperationsExpand Operations
get /sessiontokenThis is only used for automatic login from sec.kf or any external link
get /sessiontoken/{id}Create Permanent link
get /sessiontoken/dext/{oauthToken}Verify the user logged is valid for the given dext token
post /sessiontokenSend a request to get a temporary token
post /sessiontoken/mobileCreate KF session token for mobile user.
put /sessiontokenGenerate a permanent token based on valid memorable word characters and a temporary token
delete /sessiontoken/{sessionToken}Delete the session token
BackupShow/HideList OperationsExpand Operations
get /backup/{backupNumber}Download the back up file
BalanceSheetReportShow/HideList OperationsExpand Operations
get /reports/balancesheet
BankAccountShow/HideList OperationsExpand Operations
get /bankaccounts/suggestedcodeGet the next available bank code for the bank account. This is used to populate the Code field on the Create Bank Account screen
get /bankaccountsGet bank accounts list for user
get /bankaccounts/listGet paginated list of user bank accounts
get /bankaccounts/{id}Get a list of user bank accounts, by ID
post /bankaccountsCreate a new bank account
post /bankaccounts/feedsRegister the user for bank feeds
post /bankaccounts/{BankAccountId}/bankfeedsCreate a bank feed account
put /bankaccounts/{id}Update the user bank account details, by ID
put /bankaccounts/bank-orderUpdate bank account order
put /bankaccounts/{accountid}Associate bank account with KashFlow bank account
delete /bankaccounts/{id}Delete the user bank account, by ID
delete /bankaccounts/feedsRemove user from bank feeds
BankFeedShow/HideList OperationsExpand Operations
get /bankfeedsGet a list of bank feeds
get /bankfeeds/{BankFeedsAccountId}Get a list of bank feeds by account ID
get /bankfeeds/{BankFeedsAccountId}/transactionsGet a list of bank feed transactions by account ID
get /bankfeeds/{bankFeedsAccountId}/transactions/{transactionId}Get a list of bank feed transactions by transaction ID
post /bankfeeds/{BankFeedAccountId}/transactionsCreate bank feed transactions and link to the KashFlow Bank Account ID
post /bankfeeds/{bankFeedAccountId}/transactions/fileCreate a file of the bank feed transactions linked to the KashFlow Bank Account ID
delete /bankfeeds/{BankFeedsAccountId}/transactionsDelete the bank feed transactions linked to the KashFlow Bank Account ID
delete /bankfeeds/{bankFeedsAccountId}/transactions/{transactionId}Delete the bank feed transactions linked to the KashFlow Bank Account ID, by account ID
BankIconShow/HideList OperationsExpand Operations
get /bankiconsGet list of bank icons
BankReconciliationShow/HideList OperationsExpand Operations
get /bankaccounts/{bankaccountId}/reconciliations/metadataGet the next reconciliation start date and start balance for the bank account, by ID
get /bankaccounts/{bankaccountId}/reconciliationsGet a list of bank reconciliations for the bank account ID
get /bankaccounts/{bankaccountId}/reconciliations/{reconciliationId}Get bank reconciliation details, by ID
post /bankaccounts/{bankaccountId}/reconciliationsCreate a bank reconciliation
put /bankaccounts/{bankaccountId}/reconciliations/{reconciliationId}Update an existing bank reconciliation, by ID
put /bankaccounts/{bankaccountId}/reconciliations/{reconciliationId}/transactionsUpdate transactions on the bank reconciliation
delete /bankaccounts/{bankaccountId}/reconciliations/{reconciliationId}Delete the bank reconciliation, by ID
BankTransactionShow/HideList OperationsExpand Operations
get /bankaccounts/{accountId}/transactionsGet the bank transaction list, by bank account ID
get /bankaccounts/{accountId}/transactions/{transactionId}Get the bank transaction details. by account ID
get /bankaccounts/{accountId}/transactions/bfsGet a list of transactions, imported via bank feeds
get /bankaccounts/{accountId}/transactions/bfstransactionsGet details of the transaction list, imported via bank feeds
post /bankaccounts/{accountId}/transactionsCreate a bank transaction
post /bankaccounts/assign-transaction-to-new-entityCreate bank transactions to invoices and purchases and then delete the bank transaction
put /bankaccounts/{accountId}/transactions/{transactionId}Update an existing bank transaction, by ID
put /bankaccounts/{accountId}/transactionlistAssign bank transactions to invoices and purchases and then delete the bank transaction
delete /bankaccounts/{accountId}/transactions/{transactionId}Delete a bank transaction, by ID
delete /bankaccounts/{accountId}/transactionlistBulk delete bank transactions
BrandingShow/HideList OperationsExpand Operations
get /brandingGets the user branding setting set by their partner.
BulkDocumentShow/HideList OperationsExpand Operations
post /documents/invoice/bulkGenerate a link to view a PDF copy of multiple invoices
post /documents/customerstatement/bulkGenerate a link to get a statement for multiple customers
post /documents/supplierstatement/bulkGenerate a link to get a statement for multiple suppliers
post /documents/purchase/bulkGenerate a link to view a PDF copy of multiple purchase invoices
post /documents/purchasebatchpayment/bulkGenerate a link to view a PDF copy of purchase batch payment
BulkEmailShow/HideList OperationsExpand Operations
post /invoices/bulk/emailSend multiple invoices via email
post /customerstatements/bulk/emailSend multiple customer statements via email
post /supplierstatements/bulk/emailSend multiple supplier statements via email
post /InvoicePayment/bulk/emailSend multiple customer statements via email
post /purchase/bulk/emailSend multiple invoices via email
post /PurchasePayment/bulk/emailSend multiple supplier statements via email
BulkPaymentShow/HideList OperationsExpand Operations
get /{objectType}/bulk/payments/{number}Get a payment for multiple invoices or purchases
post /{objectType}/bulk/paymentsCreate a payment for multiple invoices or purchases
put /{objectType}/bulk/payments/{number}Edit a payment for multiple invoices or purchases
delete /{objectType}/bulk/payments/{number}Delete a payment for multiple invoices or purchases
BusinessReportShow/HideList OperationsExpand Operations
get /reports/business/activityGet the activity report
get /reports/business/audit/usersGet the audit report users
get /reports/business/auditGet the audit report
get /reports/business/audit/{transactionNumber}Get the audit report based on transaction number
get /reports/business/historicsalesandexpenditureGet historic sales and expenditure report
get /reports/business/stockoverviewGet stock overview report
get /reports/business/globalprojectGet global project report
get /reports/business/businessprogresssummaryGet business progress summary report
get /reports/business/digita-exportGet Digita Exports Report
get /reports/business/hsbc-factoringGet hsbc factoring details
get /reports/business/prepayments-accrualsGet prepayments and accruals report based on invoice or receipts
get /reports/business/prepayments-accruals-journals-previewGet Journals Preview
get /reports/business/health-checkGet health check report - This report tells you how you compare to a number of measures to check the health of your business.
get /reports/business/cis-summaryGet CIS Summary report.
get /reports/business/sage/entity-countGet the number of customers and suppliers created in a period.
get /reports/business/sage/audit-trail-transactionGet Audit Trail Transaction by period for Sage export report.
post /reports/business/prepayments-accruals-journals-createCreate journals for prepayment invoices/ purchases
BusinessSourcesShow/HideList OperationsExpand Operations
get /sourcesGet a list of business sources
get /sources/getSourceGet source details, by name
post /sources/createSourceCreate source
put /sources/{id}Update a source
delete /sources/deleteSourceDelete source
CardlessPaymentShow/HideList OperationsExpand Operations
post /internal/cardlesspaymentsMake a cardless payment
CardPaymentShow/HideList OperationsExpand Operations
post /internal/cardpaymentsMake a card payment
post /internal/cardpayments/{processorType}Receive a PCI payment
post /internal/cardpayments/{processorType}/refundsRefund card payment for selected payment processor
CategoryShow/HideList OperationsExpand Operations
get /categories/{entity}This API allows a developer to retrieve a list of categories available in specific IRIS KashFlow account.
post /categories/listCreate bulk quote category
put /categories/listUpdate a quote category in a bulk
delete /categories/{number}Delete a category
CategoryIconsShow/HideList OperationsExpand Operations
get /categoryiconsThis API allows a developer to retrieve a list of categories icons available in IRIS KashFlow which you can use while creating or updating quote categories and purchase order categories.
CompanyDetailsShow/HideList OperationsExpand Operations
get /settings/companydetailsGet the company details
get /settings/companydetails/industrysectorsGet the industry sector list
get /settings/companydetails/businesstypesGet the business type list
get /settings/companydetails/employeecountrangeGet the employee count range list
put /settings/companydetailsUpdate the company details
CompanyHouseShow/HideList OperationsExpand Operations
get /companieshouse/companiesGet Company Details from Company House API
CopyObjectShow/HideList OperationsExpand Operations
post /copyCreate the copy of object
CountryShow/HideList OperationsExpand Operations
get /countriesGet the country list
CountryVatRateShow/HideList OperationsExpand Operations
get /countries/vatratesGet a list of available VAT rates for different countries
CreditShow/HideList OperationsExpand Operations
get /internal/{objectType}/{objectId}/creditsGet a list of available credits that apply to an entity (advance payment, over-payment and credit note)
post /internal/{objectType}/{objectId}/creditsApply a credit to an entity (advance payment, over-payment and credit note)
CurrenciesShow/HideList OperationsExpand Operations
get /currenciesGet the available currency list
get /currencies/listGet the configured currency list
get /currencies/{code}Get currency details, by Code
post /currenciesCreate a new Currency
put /currencies/{code}Update currency details, by Code
delete /currencies/{code}Delete a currency, by Code
CustomerShow/HideList OperationsExpand Operations
get /customersThis API allows a developer to retrieve a list of customers available in specific IRIS KashFlow account.
get /customers/{code}This API allows a developer to retrieve details for a particular customer with the given code.
get /customers/searchThis API allows a developer to retrieve details for a particular customer with the given customer code or email or name.
get /customers/{code}/statisticsGet transaction statistics for a customer, by code
get /customers/statisticsGet transaction statistics for all customers
get /customers/standing-order-mandate/{customerCode}Get Standing Order Mandate details for respective customer
get /customers/schedule-statement/{customerCode}Get schedule customer statement
get /customers/confirm-to-deleteValidate multiple customers, by code
post /customersThis API allows a developer to create a new customer.
post /customers/suggestedcodeGenerate a customer code, by name
post /customers/customerbulkinvoiceGet Multiple customers invoices, by Customer Codes
post /customers/schedule-statementUpsert schedule statement details
post /internal/customers/valid-emailGet customers with valid email
put /customers/{code}This API allows a developer to modify an existing customer with the given code.
put /customers/{code}/statisticsRefresh the transaction statistics for a customer, by code
put /customers/statisticsRefresh the transaction statistics for all customers
put /customers/standing-order-mandateupdate Standing Order Mandate details
delete /customers/{code}This API allows a developer to delete an existing customer with the given code.
delete /customerlistDelete multiple customers, by code
delete /customers/schedule-statement/{customerCode}Delete schedule customer statement
CustomerAndSupplierShow/HideList OperationsExpand Operations
get /settings/customerandsupplierGet the customer and suppliers settings
put /settings/customerandsupplierUpdate the customer and suppliers settings
CustomerTransactionShow/HideList OperationsExpand Operations
get /customers/{code}/transactionsGet the customer transactions (invoice, quote, payment)
get /customerstatementtransactionGet customer statement transaction
DashboardShow/HideList OperationsExpand Operations
get /dashboard/widgetsbusinessGet the current and pervious values for Revenue, cost of sales, expenses and cashflow for a given date range
get /dashboard/financialoverviewGet financial overview data (turnover, cost of sale, gross profit, expenditure, net profit)
get /dashboard/salesoverviewGet the sales overview
get /dashboard/widgetslayoutGets the dashboard widgets layout
post /dashboard/reporttypeSet the report graph to display on the Dashboard
put /dashboard/widgetslayoutUpdates the dashboard widgets layout
DashboardOverviewShow/HideList OperationsExpand Operations
get /dashboard/overview/notificationsGets the alert notifications.
get /dashboard/overview/announcementsGets announcement by partner.
get /dashboard/overview/referralsGets referral details when partner associated user.
get /dashboard/overview/onboardersGets onboarder details.
DashboardSettingsShow/HideList OperationsExpand Operations
get /dashboard/settings/displayGets Dashboard display settings.
DashboardSummaryShow/HideList OperationsExpand Operations
get /dashboard/summary/quotesGets quotes summary.
get /dashboard/summary/importsGets data import transactions summary.
get /dashboard/summary/financialGets financial summary.
get /dashboard/summary/inapppromotionGet Unipaas InAppPromotion setting
DataImportShow/HideList OperationsExpand Operations
post /dataimportQueue the Paypal data import
DuplicateEntityShow/HideList OperationsExpand Operations
post /duplicateCopy an invoice to Invoice/Quote or vice versa
ECSLShow/HideList OperationsExpand Operations
get /ecsl/{vatReturnId}/vaterrorsGets the ECSL error details to fix VAT number
put /ecsl/{vatReturnId}/vaterrorsCheck or Update the ECSL error details to fix VAT number based on mode provided mode should either Update or CheckAndUpdate
EmailShow/HideList OperationsExpand Operations
post /emailSend an email
EmailLogShow/HideList OperationsExpand Operations
get /reports/emaillogThis API allows a developer to get an email log report. The Email Logs shows a log of all emails sent from loaded account including the status, date and timestamp, where it has been sent to and whether you used your own SMTP configuration. This can help check if there have been any problems emailing invoices over to customers and can help pinpoint if you have an issue with your SMTP configuration.
EmailOptionsShow/HideList OperationsExpand Operations
get /emailoptionsGet the data for Email options
put /emailoptionsUpdate data for Email options userIdemail
EmailTemplateShow/HideList OperationsExpand Operations
get /emailtemplatesGet a list of email templates
get /emailtemplates/{number}Get a list of email templates, by ID
get /emailtemplates/defaultStatementTemplateGet default statement template
get /emailtemplates/defaultTemplateGet default email template based on the template type
EmailTextSubstitutionShow/HideList OperationsExpand Operations
get /{objectType}/{number}/emailtextsubstitutionsGet text substitutions for placeholders in emails
ExpenseShow/HideList OperationsExpand Operations
get /expensesGet a list of expenses
get /expenses/{number}Get expense details, by ID
get /expenses/articlesGet a list of expense articles
post /expensesCreate an expense
post /expenses/articlesCreate an expense article
put /expenses/{number}Update an expense, by ID
delete /expenses/{number}Delete an expense, by ID
FeatureSwitchShow/HideList OperationsExpand Operations
get /FeatureSwitch/{switchName}Check whether a feature is enabled
get /FeatureValue/{valueName}Get the LatestTaxYear and PVAStartDate parameter values
FileShow/HideList OperationsExpand Operations
get /{objectType}/{objectNumber}/filesGet list of the files added for an entity
get /{objectType}/{objectNumber}/fileGet the details of a file added to an entity
get /dropbox/authentication/urlGenerate the referral URL for Dropbox
get /dropbox/authenticationGenerate the URL to log in to Dropbox
get /dropbox/account/infoGet the account details for Dropbox
post /{objectType}/{objectNumber}/filesAdd a file from Dropbox
post /filesUpload a file to Dropbox
post /dropbox/account/disconnectDisconnect the Dropbox account
delete /{objectType}/{objectNumber}/fileDelete a file from an entity
FixedAssetRegisterShow/HideList OperationsExpand Operations
get /fixedassetregister/reportGet Asset report for User
get /fixedassetregister/categoryGet asset category by number
get /fixedassetregister/categoriesGet asset categories
get /fixedassetregister/category-listGet list of asset categories
get /fixedassetregister/assetGet asset by number
get /fixedassetregister/asset-listGet list of assets
get /fixedassetregister/pending-assetsGet list of pending assets
get /fixedassetregister/journal-list-by-asset-numberGet list of journals by asset number
post /fixedassetregister/categoryCreate asset category
post /fixedassetregister/assetCreate asset
put /fixedassetregister/category/{categoryNumber}Update asset category
put /fixedassetregister/asset/{assetNumber}Update asset
put /fixedassetregister/pending-asset/{lineId}Remove pending asset
delete /fixedassetregister/categoryDelete asset category
delete /fixedassetregister/assetDelete asset
GoCardlessShow/HideList OperationsExpand Operations
get /gocardless/connectGenerate the URL to create a GoCardless account
get /gocardless/loginGenerate the URL to log in to GoCardless
get /gocardless/access_tokenGet the GoCardless access token, once authenticated
get /gocardless/statusGet the verification status of the GoCardless credentials
post /gocardless/WebhookCallback from GoCardless for processing mandates, payments, and payouts
delete /gocardless/disconnectDisconnect the GoCardless account
HelpShow/HideList OperationsExpand Operations
get /help/support-accessRetrieves the current support access value.
post /help/zendeskCreates a Zendesk support ticket based on the provided request details.
put /help/support-accessUpdates the support access value.
HelpContentShow/HideList OperationsExpand Operations
get /helpcontent/{helpcontentId}Get help content for selected help ID
InAppPurchasesShow/HideList OperationsExpand Operations
post /iap/receiptsCreate a new iOS subscription once receipt is received
put /iap/receiptsUpdate existing iOS subscription once receipt is received
IntegrationShow/HideList OperationsExpand Operations
get /integrationsGet a list of available integrations
delete /integrations/gocardlessRemove GoCardless from the Apps page
IntegrationsSettingsShow/HideList OperationsExpand Operations
get /integrations/settings/receiptbankGet the Receipt Bank integration information
InvoiceShow/HideList OperationsExpand Operations
get /invoicesGet a list of invoices
get /invoices/topdueGet a list of invoices, by due date
get /invoices/{number}Get invoice details, by ID
get /invoicecountforsubscriptioncycleGet invoice count for current user
post /invoicesCreate an invoice
post /internal/invoicesConvert multiple quotes to invoices
put /invoices/{number}Update an invoice
put /internal/invoicesAssign a project to multiple invoices
put /invoices/archive-status/{isArchived}Archive or unarchive multiple invoices, by invoice number
put /internal/invoices/{number}/emailcountIncrement the email count for an invoice
put /internal/invoices/{number}/emailcount/resetReset the email count for an invoice
delete /invoices/{number}Delete an invoice, by ID
delete /invoicelistDelete multiple invoices
ITSAAnnualSummaryShow/HideList OperationsExpand Operations
get /itsa/annualsummaryGet self-employment annual summary for a tax year.
put /itsa/annualsummaryCreate/ Ammend self-employment annual summary for a tax year.
delete /itsa/annualsummaryDelete self-employment annual summary for a tax year.
ITSABusinessShow/HideList OperationsExpand Operations
get /itsa/businessesGet the list of businesses for ITSA
get /itsa/businesses/{id}Get the business details, by ID
post /itsa/businessesCreate a new business (used for testing only)
ITSABusinessIncomeSourceSummaryShow/HideList OperationsExpand Operations
get /itsa/businessincomesourcesummaryRetrieve a Self-Employment Business Income Source Summary (BISS)
ITSABusinessSourceAdjustableSummaryShow/HideList OperationsExpand Operations
get /itsa/business-source-adjustable-summary/self-employment/{calculationId}Retrive Self-Employment business Source Adjustable Summary(BSAS)
get /itsa/business-source-adjustable-summary/self-employment/adjustments/{calculationId}Retrive a Self-Employment Business Source Adjustable Summary(BSAS) Adjusment
get /itsa/business-source-adjustable-summaryList Self employment Business Source Adjustable Summary(BSAS)
get /itsa/business-source-adjustable-summary/self-employment/{calculationId}/detailRetrive business Source Adjustable Summary(BSAS) in detail
post /itsa/business-source-adjustable-summary/triggerTrigger Business Source Adjustable Summary(BSAS)
post /itsa/business-source-adjustable-summary/self-employment/adjustment/{calculationId}Submit Self Employment Business Source Adjustable Summary Adjustment
ITSAIndividualLossesShow/HideList OperationsExpand Operations
get /losses/loss-claims/retrieveRetrieve a loss claim against an income source for a specific tax year for the provided claimId.
get /losses/loss-claims/listList the existing loss claims information against an income source for a specific tax year.
get /losses/brought-forward/retrieveRetrieve an existing brought forward loss against provided lossId.
get /losses/brought-forward/listList of all brought forward losses against provided taxYear.
post /losses/loss-claims/createCreate a loss claim against an income source for a specific tax year.
post /losses/loss-claims/amend-claim-typeAmend loss claim to change the type of claim for an existing loss claim type.
post /losses/brought-forward/createCreate a new brought forward loss which can be submitted against typeOfLoss 'self-employment'.
post /losses/brought-forward/amend-loss-amountUpdate an existing brought forward loss amount against the provided lossId.
put /losses/loss-claims/amend-claim-orderAmend loss claim order to change the sequence in which carry sideways losses are used.
delete /losses/loss-claims/deleteDelete an existing loss claim.
delete /losses/brought-forward/deleteDelete an existing brought forward loss.
ITSALogsShow/HideList OperationsExpand Operations
get /itsa/logs/tax-calculationGet a list of Tax Calculations
get /itsa/logs/submissionGet a list of Submission Logs.
get /itsa/logs/bsasGet a list of Business Source Adjustable Summary Logs
ITSANotificationsShow/HideList OperationsExpand Operations
get /itsa/notificationGet Notification base on conditions
ITSAObligationShow/HideList OperationsExpand Operations
get /itsa/obligations/income-and-expenditureGet the list of ITSA Income and Expenditure obligations
get /itsa/obligations/crystallisationGet Crystallisation obligations
get /itsa/obligations/allowance-and-adjustmentGet Allowances and Adjustment
post /itsa/obligations/crystallisationPost Crystallisation obligations
ITSAPeriodShow/HideList OperationsExpand Operations
post /itsa/periodsCreate the ITSA periods
post /itsa/periods/by-hmrcUpsert ITSA periods submitted to HMRC
put /itsa/periods/quarterly-period-typeCreate and Amend Quarterly Period Type for a Business
delete /itsa/periodsDelete any unsubmitted ITSA periods
ITSAPeriodicUpdateShow/HideList OperationsExpand Operations
get /itsa/periodicupdateGet the ITSA Periodic Update
get /itsa/periodicupdate/cumulative-periodic-updateRetrieve an self employment Cumulative Periodic Update
post /itsa/periodicupdateCreate an ITSA Periodic Update
put /itsa/periodicupdateAmend an ITSA Periodic Update
put /itsa/periodicupdate/cumulative-periodic-updateCreate or amend an ITSA Cumulative Periodic Update
ITSASettingShow/HideList OperationsExpand Operations
get /itsa/settingsGet the ITSA settings
get /itsa/settings/GetAccountingYearListGet the ITSA Accounting Period list
put /itsa/settingsConfigure the ITSA settings
ITSASubmissionGatewayShow/HideList OperationsExpand Operations
get /itsa/submission/auth_urlGet the authorization URL for the MTD ITSA API
get /itsa/submission/accesstokenGet the ITSA submission authorization result
delete /itsa/submission/disconnectDelete the MTD ITSA authorization token
ITSATaxCalculationShow/HideList OperationsExpand Operations
get /itsa/taxcalculationGet List of Tax Calculation
get /itsa/taxcalculation/{calculationId}/income-tax-nics-calculatedTo Get Income tax and NICs Data
get /itsa/taxcalculation/{calculationId}/income-tax-allowances-deductions-reliefsTo Get Income tax allowances deductions reliefs
get /itsa/taxcalculation/{calculationId}/taxable-incomeTo Get Taxable Income
get /itsa/taxcalculation/{calculationId}/end-of-year-estimateTo Get End of year estimate
get /itsa/taxcalculation/{calculationId}/metadataTo Get Tax Calculated Metadata
get /itsa/taxcalculation/{calculationId}/tax-calculation-messagesTo Get tax calculation messages
get /itsa/taxcalculation/{calculationId}/consolidate-tax-calculationGet Consolidated Tax Calculation
get /itsa/taxcalculation/tax-calculation-idGet Tax calculation id
get /itsa/taxcalculation/liability/{taxYear}Get Income Tax Or Liability
get /itsa/taxcalculation/{calculationId}/tax-calculationRetrieve tax calculation
get /itsa/taxcalculation/{calculationId}/reportGet Tax calculation for Report
post /itsa/taxcalculationCreate Tax calculation at HMRC
JobAlertsShow/HideList OperationsExpand Operations
get /jobs/alert/hmrconlinefilingGet the HMRC online filing job status
JournalsShow/HideList OperationsExpand Operations
get /journalsGet the journal list
get /journals/{number}This API allows a developer to retrieve details of a specific journal by number.
get /journals/template/{number}This API allows a developer to retrieve details of a specific journal by number.
get /journals/templateGet the journal list
post /journalsThis API allows a developer to create a new journal.
post /journals/templateThis API allows a developer to create a new journal template.
put /journals/{journalNumber}This API allows a developer to modify an existing journal with the given number.
put /journals/template/{number}This api allows user to update journal template
delete /journals/{number}This API allows a developer to delete an existing journal with the given number.
delete /journallistDelete multiple journals, by Journal Numbers
delete /journaltemplatelistDelete multiple journal templates, by Journal template numbers
JsErrorShow/HideList OperationsExpand Operations
post /jserrorReceive browser-related JavaScript errors
LoginLogShow/HideList OperationsExpand Operations
get /reports/loginlogThis API allows a developer to get login log report. The Login Logs API gives a list of all the users who have logged into the account over a given period. This shows the date and timestamp, username, the type of user account they have, and the IP address used. This is particularly useful if you find any irregularities on your account and want to see how it may have happened or who has been into the account.
MailTimeLineShow/HideList OperationsExpand Operations
get /mailtimelineGet email status
ManagementReportShow/HideList OperationsExpand Operations
get /reports/managementreportGet the management report
post /reports/managementreportCreate a management report
MandateShow/HideList OperationsExpand Operations
get /customers/{customerCode}/mandatesGet the customer mandate information
get /customers/{customerCode}/mandates/initiate/customertoken/{customerSessionToken}Generate the URL to confirm the customer mandate
get /oneOff/initiate/customertoken/{customerSessionToken}/invoices/{invoiceId}Generate the URL to confirm the customer mandate for a one-off payment or a PayOnline payment
get /customers/{customerCode}/mandates/confirm/customertoken/{customerSessionToken}Create a mandate once GoCardless authorization is received
get /oneoff/confirm/customertoken/{customerSessionToken}/invoices/{invoiceId}Create a one-off payment once GoCardless authorization is received
post /customers/{customerCode}/mandatesCreate a new customer mandate
post /customers/{customerCode}/mandates/existingMandateAdd an existing customer mandate
delete /customers/{customerCode}/mandatesDelete a customer mandate
MatchingEngineShow/HideList OperationsExpand Operations
get /matchingengine/import/draft/{bankAccountId}Get Bank Transaction Draft
post /matchingengine/import/{bankAccountId}import transactions into specific entities
post /matchingengine/import/draftUpsert Bank Transaction Draft
delete /matchingengine/import/draft/{bankAccountId}Delete Bank Transaction Draft
MetadataShow/HideList OperationsExpand Operations
get /metadataGet the account metadata(total invoice count, total customer count, for example)
MileageShow/HideList OperationsExpand Operations
get /mileage/enginesizesGet the engine size list
get /mileage/enginetypesGet the engine type list
get /mileage/vehicletypesGet the vehicle type list
get /mileage/employeeGet all employees
post /mileage/employeeCreate employee for mileage
post /mileage/employeesCreate bulk employees for mileage
put /mileage/employee/{employeeName}Update employee for mileage
put /mileage/employeesUpdate bulk employees for mileage
delete /mileage/{employeeId}Delete employee by id
NextAvailableNumberShow/HideList OperationsExpand Operations
get /nextavailableinvoicenumberGet the next available invoice number
get /nextavailableprojectnumberGet the next available project number
get /nextavailablepurchasenumberGet the next available purchase number
get /nextavailablequotenumberGet the next available quote number
get /nextavailablepurchaseordernumberGet the next available purchase order number
NominalShow/HideList OperationsExpand Operations
get /nominalsGet the nominal list
get /nominals/{nominalType}/nominalsGet the list of nominals for the reassign transactions along with the details of deleting nominal
get /nominals/{nominalCode}Get user nominals, by code
get /nominals/Id/{nominalId}Get user nominals, by ID
get /nominals/sa103categoriesGet the SA103 category list
get /nominals/IsSa103MappingTo check all sa103 values are correctly mapped or not
post /nominalsCreate a nominal
post /internal/discountnominalCreates a discount nominal
post /nominals/specialCreate a special nominal
put /nominalsUpdate the SA103 category for multiple nominals
put /nominals/Id/{nominalId}Update a nominal, by ID
put /nominals/{nominalcode}Update an nominal
put /nominals/Code/{nominalCode}Update user default nominal type by code
delete /nominals/{nominalCode}Delete a nominal by reassigning transactions to another nominal, By Code
delete /nominals/Id/{nominalId}Delete a nominal by reassigning transactions to another nominal, By Id
delete /nominals/{assignedCode}/nominallistBulk delete nominal by code
NominalLedgerReportShow/HideList OperationsExpand Operations
post /reports/nominalledger/guid
NoteShow/HideList OperationsExpand Operations
get /{objectType}/{objectNumber}/notesGet a list of notes for an object, such as Customer or Supplier
get /{objectType}/{objectNumber}/notes/{number}Get note details, by object and ID
post /{objectType}/{objectNumber}/notesCreate a note for an object, such as Customer or Supplier
put /{objectType}/{objectNumber}/notes/{number}Update a note for an object, such as Customer or Supplier
delete /{objectType}/{objectNumber}/notes/{number}Delete a note for an object, such as Customer or Supplier
OAuthShow/HideList OperationsExpand Operations
get /okta/oauth-urlGenerate the URL to log in to elements account
get /irisoauth/accesstokenGet the Elements access token, once authenticated
OcrFileShow/HideList OperationsExpand Operations
get /ocr/file/extraction-detailGet OCR extraction detail
PartnerShow/HideList OperationsExpand Operations
get /partners/{partnerId}Get partner details, by ID
get /partners/{partnerId}/rsrcssdetailsGet the details of the partner's default company branding colours
PasswordShow/HideList OperationsExpand Operations
get /password/{resetToken}Get a password reset token
post /passwordSend a password reset link
post /password/breachedCheck if password breached beyond a limit
put /passwordChange password and/or memorable word
put /password/{resetToken}Use a token to reset credentials
PaymentMethodShow/HideList OperationsExpand Operations
get /paymentmethods/{type}Get the payment method details for an invoice or purchase
PaymentProcessorShow/HideList OperationsExpand Operations
get /paymentprocessorsGet a list of payment processors
get /paymentprocessors/worldpayGet the WorldPay payment processor configuration details
get /paymentprocessors/{processorType}/configurationGet the payment processor settings
get /paymentprocessors/activedeprecatedGet the list of active deprecated payment processors
get /paymentprocessors/{processorType}/authorizeAuthorize the payment processor
get /paymentprocessors/{processorType}/oauthauthorizeurlGet the OAuth authorize URL
get /paymentprocessors/{processorType}/transactions/{transactionId}/metadataGet the transaction metadata for the payment processor
post /paymentprocessors/worldpayCreate the WorldPay configuration details
put /paymentprocessors/worldpayUpdate the WorldPay configuration details
put /paymentprocessors/{processorType}/configurationUpdate the card payment configuration details
put /paymentprocessors/{processorType}/defaultUpdate the default payment processor used for card payments
put /paymentprocessors/AdvtPaymentUpdate the default payment processor using the Acquirer Device Validation Toolkit
put /paymentprocessors/{processorType}/disconnectDisconnect the payment processor
delete /paymentprocessors/{processorType}/defaultRemove the default payment processor
PaymentStatusShow/HideList OperationsExpand Operations
get /paymentstatusesGet a list of payment statuses
PaymentUnallocationShow/HideList OperationsExpand Operations
post /internal/{objectType}/{number}/payments/{paymentId}/unallocateRemove the allocation of a payment from an entity
PayOnlineShow/HideList OperationsExpand Operations
get /payonline/{invoiceId}Get the PayOnline information for the selected invoice
get /payonline/resultDecrypt the PayOnline secret key
get /payonline/worldpay/secretGet the Worldpay secret key for the PayOnline service
get /payonline/worldpay/signatureVerify captcha and generate Md5 encrypted value from string
post /payonline/{processorType}Receive a Payment Card Industry (PCI) payment via PayOnline
post /payonline/globalpayments/iframeSet the Global Payments configuration details for the PayOnline service
PayrollActivationShow/HideList OperationsExpand Operations
post /internal/payrollactivationSet the provisioning status of the payroll application (The visibility of the payroll modal depends on this setting)
PermaLinkShow/HideList OperationsExpand Operations
get /documents/{documentType}/bulk/{id}Generate multiple PDFs for an entity
get /documents/{documentType}/{id}Generate a single PDF for an entity
get /documents/invoice/payment/{id}Get a PDF of the invoice payment
get /documents/purchase/payment/{id}Get a PDF of the purchase payment
PermissionShow/HideList OperationsExpand Operations
get /userpermissionsGet the user permissions
get /userpermissions-mobileGet the user permissions for mobile app
PermissionHierarchyShow/HideList OperationsExpand Operations
get /permissionhierarchyGet the Permission Hierarchy
ProductShow/HideList OperationsExpand Operations
get /productsGet the product list
get /products/listThis API allows a developer to retrieve a list of products available in specific IRIS KashFlow account. .
get /nominals/{nominalcode}/productsThis API allows a developer to retrieve a list of products available under a specific nominal in specific IRIS KashFlow account.
get /products/{nominalCode}/{code}Get product details, by code
post /productsThis API allows a developer to create a new product.
put /products/{nominalCode}/{code}Update an product
delete /products/{nominalCode}/{code}Delete a product by code
ProfitAndLossReportShow/HideList OperationsExpand Operations
get /reports/profitandlossThis API allows a developer to get Profit and Loss report. It lists your Turnover less your Cost of Sales to give you your Gross Profit. Expenses are then subtracted from your Gross Profit to give you your net profit.
get /reports/profitandloss/monthly-profit-lossGet monthly profit and loss report within the date range passed.
get /reports/profitandloss/monthly-profit-loss-csvGet monthly profit and loss breakdown for csv.
ProjectShow/HideList OperationsExpand Operations
get /projectsThis API allows a developer to retrieve a list of projects available in specific IRIS KashFlow account.
get /customers/{code}/projectsThis API allows a developer to retrieve a list of projects available in specific IRIS KashFlow account for given customer code.
get /projects/{number}This API allows a developer to retrieve details for a particular project with the given number.
post /projectsThis API allows a developer to create a new customer.
put /projects/{number}This API allows a developer to modify an existing project by number.
delete /projects/{number}This API allows a developer to delete existing project with given number.
PromoShow/HideList OperationsExpand Operations
get /subscription/promoGet the promotion code applied to a subscription
put /subscription/promoChange the promotion code applied to a subscription
PurchaseShow/HideList OperationsExpand Operations
get /purchasesGet a list of purchases for the selected company
get /purchases/topdueGet the list of purchases, by due date ascending
get /purchases/{number}Get the purchase details, by ID
get /purchasescountforsubscriptioncycleGet invoice count for current user
get /purchases/optionGet the purchase options
post /purchasesCreate purchase
post /purchases/{number}/reverseReverse a purchase included in a submitted VAT return
post /purchaselistCreate multiple purchases
post /internal/purchasesConvert a purchase order to a purchase
put /purchases/{number}Update a purchase
put /purchases/{number}/emailSet the email flag as sent or unsent for the purchase
put /internal/purchasesAssign a project to multiple purchase invoices
put /purchase/optionsUpdate purchase options
delete /purchases/{number}Delete a purchase
delete /listDelete multiple purchase invoices/expenses
PurchaseOrderShow/HideList OperationsExpand Operations
get /purchaseordersGet a list of purchase orders
get /purchaseorders/{number}Get the purchase order details, by ID
post /purchaseordersCreate a purchase order
put /purchaseorders/{number}Update a purchase order
put /purchaseorders/{number}/emailSet the email flag as sent or unsent for the purchase order
delete /purchaseorders/{number}Delete a purchase order
delete /purchaseorderlistDelete multiple purchase orders
PurchaseOrderCategoryShow/HideList OperationsExpand Operations
get /purchaseordercategoriesGet a list of purchase order categories
post /purchaseordercategoriesCreate a purchase order category
post /purchaseordercategories/defaultsCreate a default purchase order category
post /purchaseordercategories/categorieslistCreate bulk purchase order category
put /purchaseordercategories/{number}Update Purchase Order Category
put /purchaseordercategories/categorieslistUpdate a Purchase Order category in a bulk
delete /purchaseordercategories/{number}Delete a purchase order category, by ID
PurchaseOrderSettingShow/HideList OperationsExpand Operations
get /settings/purchaseorderGet the purchase order settings
post /settings/purchaseorderCreate an initial purchase order setting
put /settings/purchaseorderUpdate the purchase order settings
PurchaseReportShow/HideList OperationsExpand Operations
get /reports/purchase/unallocated-supplier-paymentGet the Unallocated Supplier Payments Report
get /reports/purchase/expenditureGet expenditure report by expenditure type
get /reports/purchase/expenditure-by-payment-methodGET Expenditure by payment method report
get /reports/purchase/suppliersGet supplier report
get /reports/purchase/expenditure-report-subpurchasecode-csvGet Expenditure by Sub Purchase Code Report - CSV download
QuoteShow/HideList OperationsExpand Operations
get /quotesGet a list of quotes for the selected company
get /quotes/{number}Get the quote details, by ID
post /quotesCreate a quote
put /quotes/{number}Update a quote
put /quotes/{number}/emailSet the email flag as sent or unsent for the quote
delete /quotes/{number}Delete a quote
delete /quotelistDelete multiple quotes
QuoteCategoryShow/HideList OperationsExpand Operations
get /quotecategoriesThis API allows a developer to retrieve a list of quote categories available in specific IRIS KashFlow account.
post /quotecategoriesCreate a quote category
post /quotecategories/categorieslistCreate bulk quote category
put /quotecategories/{number}Update a quote category
put /quotecategories/categorieslistUpdate a quote category in a bulk
delete /quotecategories/{number}Delete a quote category
QuoteReportShow/HideList OperationsExpand Operations
get /reports/quotesThis API allows a developer to get a list of quotations over a specified period.
ReceiptBankShow/HideList OperationsExpand Operations
post /integrations/receiptbankIntegrate Receipt Bank with the IRIS KashFlow account
RecurringBankTransactionShow/HideList OperationsExpand Operations
get /recurringbanktransactionGet a list of recurring bank transaction
get /recurringbanktransaction/{number}Get the details of recurring bank transaction, by number
post /recurringbanktransactionCreate recurring bank transaction
put /recurringbanktransaction/archivestatus/{isArchived}Archive or unarchive multiple recurring bank transaction, by recurring transaction number
put /recurringbanktransaction/{number}Update recurring bank transaction
delete /recurringbanktransactionDelete multiple recurring bank transaction
RecurringInvoiceShow/HideList OperationsExpand Operations
get /recurringinvoicesGet a list of recurring invoices
get /recurringinvoices/{number}Get the details of recurring invoices, by ID
get /customers/{code}/recurringinvoicesGet the list of recurring invoices, by customer code
post /recurringinvoicesCreate recurring invoice
put /recurringinvoices/{number}Update a recurring invoice, by ID
delete /recurringinvoices/{number}Delete a recurring invoice, by ID
RecurringPurchaseShow/HideList OperationsExpand Operations
get /recurringpurchasesGet a list of recurring purchases
get /recurringpurchases/{number}Get the recurring purchase details, by ID
get /suppliers/{code}/recurringpurchasesGet the recurring purchase list, by customer code
post /recurringpurchasesCreate a recurring purchase
put /recurringpurchases/{number}Update a recurring purchase, by ID
delete /recurringpurchases/{number}Delete a recurring purchase by ID
ReferralShow/HideList OperationsExpand Operations
post /referral/codeCreate a referral code
RefundShow/HideList OperationsExpand Operations
post /internal/invoices/refund/baddebtCreate a bad debt record for an invoice
ReminderLetterShow/HideList OperationsExpand Operations
get /reminderlettersGet list of reminder letters
get /defaults/reminderletters/{number}Get reminder letter details, by number
post /invoices/{invoicenumber}/reminderlettersCreate a reminder letter
put /reminderletters/{number}Update a reminder letter
put /invoices/{invoicenumber}/reminderletters/{reminderletternumber}Mark a reminder letter as sent
ReportShow/HideList OperationsExpand Operations
get /reportsGet a list of reports
put /reports/{reportId}Update the report details
ReportCacheShow/HideList OperationsExpand Operations
delete /reportcacheDelete all reports
ReportCoverSheetShow/HideList OperationsExpand Operations
get /reports/coversheetGet the client and partner details for the cover sheet
ReportsSettingsShow/HideList OperationsExpand Operations
get /reports/settingsGet the report UI settings
put /reports/settingsSet the report UI settings
RoleShow/HideList OperationsExpand Operations
get /rolesGet a list of roles
SalesAgentShow/HideList OperationsExpand Operations
post /salesagent/createcustomer
post /salesagent/chargecard
post /salesagent/createinvoice
post /salesagent/emailinvoice
post /salesagent/migratepartnerMigrate the partner details to PayAdmin
post /salesagent/emailcreditbalance
post /salesagent/customerexists
SalesReportShow/HideList OperationsExpand Operations
get /reports/sales/unallocated-customer-paymentGet the Unallocated Customer Payments Report
get /reports/sales/unpaid-invoicesGet unpaid invoice report
get /reports/sales/sales-code-by-monthGet Sales Codes by Month Report
get /reports/sales/incomeGet sales income report
get /reports/sales/sales-historyGet sales history report
get /reports/sales/overdue-invoicesGet overdue invoice report
get /reports/sales/monthlyGet monthly sales report
get /reports/sales/customer-purchase-historyGet customer purchase history report
get /reports/sales/customer-reportGet customer report
get /reports/sales/income-report-by-product-csvGet income report by product download csv
get /reports/sales/income-report-by-salescode-csvGet income report by sales code download csv
get /reports/sales/income-report-by-paymentmethod-csvGet income report by method download csv
get /reports/sales/income-report-by-source-csvGet income report by souce csv
SearchShow/HideList OperationsExpand Operations
get /searchGets the search results based on the provided search text and filters.
SelfAssessmentTaxShow/HideList OperationsExpand Operations
get /tax/selfassessmentThis API allows a developer to get a self-assessment report. This report gives you the figures you’ll need to file your self-assessment tax returns to HMRC.
SendGridWebhookShow/HideList OperationsExpand Operations
post /sendgridwebhookUpdate sendgrid mail status from webhook
SettingsShow/HideList OperationsExpand Operations
get /settingsGet the account settings
get /settings/singleGet a specific account setting for the selected user
get /settings/advancedGet the advanced account settings for the selected user
get /settings/invoiceGet the invoice settings for the account
get /settings/menuGet the main menu settings
get /settings/projectGet the project settings
get /settings/quoteGet the quote settings
get /settings/userGet the account settings for the selected user
get /settings/referralGet the referral settings
get /settings/apiGet the API settings
get /settings/termsandconditionsGet the setting that determines whether the Terms & Conditions are displayed
get /settings/gocardlessGet the payment processor settings for GoCardless
get /settings/mileageGet the mileage settings
get /settings/pdfthemesGet a list of PDF themes
get /settings/profileGet user profile details
post /settings/termsandconditionsAccept the Terms & Conditions
post /settings/docfireDisable the docfire dialog box
post /settings/mileageSave the mileage settings
put /settings/apiUpdate the API settings
put /settings/gocardlessUpdate the GoCardless settings
put /settings/mileageUpdate the mileage settings
put /settings/profileUpdate user profile details
SignedUriShow/HideList OperationsExpand Operations
get /oauthsigneduriGenerate the signed url for authentication
SignupShow/HideList OperationsExpand Operations
get /signupsCheck the validity of the activation link
get /signups/activationlinkGet the activation link
post /signupsCreate the user account
post /signups/credentialsCreate the user account with valid credentials
post /signups/iris-userCreate the user account
put /signupsExpire the existing activation link, create a new activation link, and send via email to the user
SMTPConfigShow/HideList OperationsExpand Operations
get /SMTPConfigGet the user’s SMTP configuration
put /SMTPConfigUpdate the user’s SMTP configuration
delete /SMTPConfigDelete the user’s SMTP configuration
SMTPOAuthShow/HideList OperationsExpand Operations
get /SMTPOAuth/authurlGet the authorization URL for Outlook OAuth
get /SMTPOAuth/accesstokenCalled by Outlook once authorization is successful
delete /SMTPOAuth/disconnectDelete the OAuth access token
StockOptionsShow/HideList OperationsExpand Operations
get /stockoptionsGet the data for stock options
put /stockoptionsUpdate the data for stock options
SubscriptionShow/HideList OperationsExpand Operations
get /subscription/cancellationreasonsGet the list of subscription cancellation reasons
get /subscription/packagesGet the list of subscription packages
get /subscription/packages/iosGet the list of subscription packages available for iOS
get /subscriptionGet the subscription details of the user
get /subscription/chargedDetailsGet the charged details for the package ID
get /subscription/cancel/reasonsGet cancellation reason subcategories
get /subscription/cancel/competitorsGet the list of competitors
put /subscriptionUpdate the user subscription
put /subscription/forwardUpdate the subscription expiry date
delete /subscriptionCancel the subscription
SupplierShow/HideList OperationsExpand Operations
get /suppliers/{code}/statisticsGet the supplier transaction statistics, by code
get /suppliers/statisticsGet all supplier transaction statistics
get /suppliers/statistics/transactions/visibilityGet the visibility status of transaction statistics on the Supplier Details page
get /suppliers/statistics/dashboard/visibilityGet the visibility status of transaction statistics on the Supplier List page
get /suppliersGet the supplier list
get /suppliers/{code}Get the supplier details, by code
get /suppliers/confirm-to-deleteValidate multiple suppliers, by code
post /suppliersCreate a new supplier
post /suppliers/suggestedcodeGenerate a supplier code, by name
post /internal/suppliers/supplierbulkinvoiceGet Multiple suppliers invoices, by Supplier Codes
post /internal/suppliers/valid-emailGet suppliers by valid email
put /suppliers/{code}/statisticsRefresh the transaction statistics for a supplier, by code
put /suppliers/statisticsRefresh the transaction statistics for all suppliers
put /suppliers/statistics/transactions/visibilityToggle the visibility of the transaction statistics on the Supplier Details page
put /suppliers/statistics/dashboard/visibilityToggle the visibility of the transaction statistics on the Supplier List page
put /suppliers/{code}Update the supplier details, by code
put /internal/suppliers/archiveArchive multiple suppliers, by code
delete /suppliers/{code}Delete a supplier, by code
delete /internal/suppliers/supplierlistDelete multiple suppliers, by code
SupplierTransactionShow/HideList OperationsExpand Operations
get /suppliers/{code}/transactionsGet the supplier transactions (purchase, purchase order, payment)
get /supplierstatementtransactionGet Supplier Statement Transaction
TaxShow/HideList OperationsExpand Operations
get /taxesGet the taxes list
TrialBalanceReportShow/HideList OperationsExpand Operations
get /reports/trialbalanceThis API allows a developer to retrieve Trial Balance. “TB” or “General Ledger”, is a list of all the Nominal Accounts (both revenue and capital) contained in the business.
get /reports/trialbalance/firsttransactiondateGet the Trial Balance report from the first transaction date
TripShow/HideList OperationsExpand Operations
get /mileage/trips/tripcostGet the cost of a trip
get /mileage/trips/{number}Get trip details, by ID
get /mileage/tripsGet a list of trips
get /mileage/trips/overviewGet Mileage overview for the tax year provided with Previous year
post /mileage/tripsCreate a new trip
put /mileage/trips/{number}Update a trip, by ID
delete /mileage/trips/{number}Delete a trip, by ID
UserShow/HideList OperationsExpand Operations
get /usersGet a list of additional users
get /users/{number}Get the additional user details
get /users/activation/{activationGuid}Get the additional user’s activation key
get /users/haslegacyusersCheck for expired users on the selected account
post /usersCreate an additional user
post /users/activation/{activationGuid}/emailCreate an activation key for the additional user
post /users/{number}/activationemailResend the activation email to the additional user
put /users/{number}Update the additional user, by ID
put /users/activation/{activationGuid}/credentialUpdate the activation key for the additional user
delete /users/{number}Delete an additional user, by ID
VatLiabilityShow/HideList OperationsExpand Operations
get /vatliabilityGet the aggregate VAT liability amount for the last 12 months
VatMossReturnShow/HideList OperationsExpand Operations
get /reports/vatmossGet the VAT Mini One Stop Shop (MOSS) returns list
get /reports/vatmoss/{id}Get the VAT Mini One Stop Shop (MOSS) Return Detail report for the submitted return, by ID
get /reports/vatmoss/{id}/drilldownGet the VAT Mini One Stop Shop (MOSS) Return Drilldown report for the submitted return, by ID
get /reports/vatmoss/drilldownGet the VAT Mini One Stop Shop (MOSS) Return Drilldown report for the open return, by quarter
post /reports/vatmossCreate a new VAT Mini One Stop Shop (MOSS) return
delete /reports/vatmoss/{id}Delete a VAT Mini One Stop Shop (MOSS) return
VatMossReturnUnauthorizedShow/HideList OperationsExpand Operations
get /reports/vatmoss/{guid}Download the VAT Mini One Stop Shop (MOSS) Return Detail report
VatReportShow/HideList OperationsExpand Operations
get /reports/vat/zeroratedThis API allows a developer to get zero rated VAT Report. This report provides 0% and NA VAT Transactions for any given period.
get /reports/vat/salesreportGet ec and non-ec sales report
get /reports/vat/trading-detailsGet Vat return trading details
VatReturnShow/HideList OperationsExpand Operations
get /vatreturns/{id}Get the VAT return details, by period key
get /vatreturnsGet a list of VAT returns
get /vatreturns/YearsGet a list of submitted and open VAT returns, by year
get /vatreturns/{id}/detailsGet the transactions in the VAT return, by period key
get /vatreturns/{id}/csvGet the VAT return details in CSV format, by period key
get /vatreturns/detailsThis API allows a developer to get VAT return details by KashFlow Id or period Id .
get /vatreturns/summaryGet VAT return summary by Id or period Id
post /vatreturns/{id}Submit the VAT return, by period key
post /vatreturnsCreate a VAT return
put /vatreturns/{id}Update a VAT return
put /vatreturns/{id}/paidstatusMark an open VAT return as paid
put /vatreturns/{id}/markasopenMark a paid VAT return as open
delete /vatreturns/{id}Delete a VAT return
delete /vatreturns/{id}/paidstatusMark the paid VAT return as open
VatSettingShow/HideList OperationsExpand Operations
get /settings/vatGet the VAT settings
get /settings/VATNumberValidate the VAT number
get /settings/vatratesGet the VAT rates
get /vatratesGet the VAT rates
put /settings/vatUpdate the VAT settings
put /settings/vat/displayMtdRecommendedModalUpdate the MTD Recommended flag for VAT settings
VatSettingsShow/HideList OperationsExpand Operations
get /vat/settingsGets the user VAT settings.
get /vat/settings/vatratesGets the user VAT rates.
post /vat/settings/vatrates/{vatRate}Create new a VAT rate
put /vat/settingsUpdates the user VAT settings.
delete /vat/settings/vatrates/{vatRateId}Delete a VAT rate, by vatRateId
VatSubmissionGatewayShow/HideList OperationsExpand Operations
get /vatsubmissiongateway/auth_urlGet the authorization URL for the MTD VAT API
get /vatsubmissiongateway/accesstokenGet the MTD VAT API access token for authorization
delete /vatsubmissiongateway/disconnectDelete the MTD VAT API access token from the database
ViaPostShow/HideList OperationsExpand Operations
get /viapost/balanceGet the ViaPost account balance
post /viapostSend a file using ViaPost
WithholdingTaxDeductionShow/HideList OperationsExpand Operations
post /internal/{objectType}/{objectNumber}/withholdingtaxdeductionApply witholding tax deduction to an Invoice/Purchase
Response Class (Status 200)
ModelModel Schema
{}


Response Content Type 
application/json
Parameters
Parameter	Value	Description	Parameter Type	Data Type
objectType	
(required)
Object Type: Invoice or purchase

path	string
objectNumber	
(required)
Object Number

path	integer
YearEndReportShow/HideList OperationsExpand Operations
post /reports/yearendCreate the Year End report for the accounting period ID
post /reports/yearend/nominalcodeCreate a nominal code for the Year End Journal


[ base url: /v2 , api version: v1 ]

- https://api.kashflow.com/v2/swagger/ui/index