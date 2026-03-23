KashFlow REST API (v1 on base /v2)
=================================

Base URL: `https://api.kashflow.com/v2`
Swagger UI: `https://api.kashflow.com/v2/swagger/ui/index`

Purpose
-------
Concise, human‑readable index of KashFlow REST endpoints extracted from the original Swagger dump. Each resource group lists HTTP method, path, and a brief description. (Original verbose markers like "Show/HideList Operations" removed.)

Legend: `GET` read, `POST` create/action, `PUT` update, `DELETE` delete.

Model Coverage Legend
---------------------
`[MODELED]` We have an internal Mongoose model for this resource.
`[PARTIAL]` Only part of the resource family is modeled.
`[NONE]` No direct model (default; omitted tag).

Mapped Models (schema source → hcs-app model → hcs-sync model → resource):
- `hcs-schemas/lib/customer.js` → `mongoose/models/mongoose/REST/customer.js` → `src/server/models/kashflow.js:Customer` → Customers
- `hcs-schemas/lib/supplier.js` → `mongoose/models/mongoose/REST/supplier.js` → `src/server/models/kashflow.js:Supplier` → Suppliers
- `hcs-schemas/lib/invoice.js` → `mongoose/models/mongoose/REST/invoice.js` → `src/server/models/kashflow.js:Invoice` → Invoices
- `hcs-schemas/lib/purchase.js` → `mongoose/models/mongoose/REST/purchase.js` → `src/server/models/kashflow.js:Purchase` → Purchases
- `hcs-schemas/lib/project.js` → `mongoose/models/mongoose/REST/project.js` → `src/server/models/kashflow.js:Project` → Projects
- `hcs-schemas/lib/quote.js` → `mongoose/models/mongoose/REST/quote.js` → `src/server/models/kashflow.js:Quote` → Quotes
- `hcs-schemas/lib/nominal.js` → `mongoose/models/mongoose/REST/nominal.js` → `src/server/models/kashflow.js:Nominal` → Nominals
- `hcs-schemas/lib/note.js` → `mongoose/models/mongoose/REST/note.js` → `src/server/models/kashflow.js:Note` → Notes
- `hcs-schemas/lib/vatRate.js` → `mongoose/models/mongoose/REST/vatRate.js` → `src/server/models/kashflow.js:VATRate` → VAT Rates

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

**GET /countries** → `[ { Id, Code, Name, IsEU } ]`

**GET /countries/vatrates** → `{}` (empty object — no data returned)

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

**GET /invoices** → Paginated `{ MetaData, Data: [ { Number, IssuedDate, DueDate, PaidDate, VATAmount, NetAmount, TotalPaidAmount, GrossAmount, Status, HomeCurrencyGrossAmount, ProjectGrossAmount, CustomerName, CustomerId, EmailCount, OverdueDays, DueAmount, ProjectName, FileCount, VATReturnId, Type, TradeBorderType, IsArchived, LineItems, Address, Currency, HomeCurrencyVATAmount, CISRCVatAmount, Id, ProjectNumber, IsCISReverseCharge, CustomerCode, CustomerReference, AutomaticCreditControlEnabled, CustomerKey } ] }`

**GET /invoices/{number}** → `{ Number, IssuedDate, DueDate, PaidDate, Address, DeliveryAddress, LineItems, PaymentLines: [ { Id, Date, BulkId, BFSTransactionId, BankTransactionId, Reference, PaymentProcessor, BulkPaymentNumber, Permalink, PaymentProcessorEnumValue, VATReturnId, IsPaymentCreditNote, AccountId, Note, Method, Amount } ], ReminderLetters, LastPaymentDate, CISRCNetAmount, CISRCVatAmount, HomeCurrencyVATAmount, IsCISReverseCharge, VATNumber, CustomerDiscount, CustomerContactName, CustomerContactFirstName, CustomerContactLastName, Currency, Permalink, PackingSlipPermalink, IsWhtDeductionToBeApplied, FormattedDueAmount, PreviousNumber, NextNumber, UseCustomDeliveryAddress, CreatedDate, VATAmount, NetAmount, TotalPaidAmount, GrossAmount, Status, HomeCurrencyGrossAmount, ProjectGrossAmount, CustomerName, CustomerId, EmailCount, OverdueDays, DueAmount, ProjectName, FileCount, VATReturnId, Type, TradeBorderType, IsArchived, Id, ProjectNumber, CustomerCode, CustomerReference, AutomaticCreditControlEnabled, CustomerKey }`

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
Object types: 1 = Customers, 2 = Suppliers, 3 = Invoices, 4 = Quotes, 5 = Purchases, 6 = PurchaseOrders.

**GET /{objectType}/{objectNumber}/notes** → `[ { Number, Text, Date, LastModifiedBy } ]`

**GET /{objectType}/{objectNumber}/notes/{number}** → `{ Number, Text, Date, LastModifiedBy }`

**POST /{objectType}/{objectNumber}/notes** — Body: `{ Text }` → 201: `{ Number, Text, Date, LastModifiedBy }`

**PUT /{objectType}/{objectNumber}/notes/{number}** — Body: `{ Number, Text }` → `{ Number, Text, Date, LastModifiedBy }`

**DELETE /{objectType}/{objectNumber}/notes/{number}** → 204

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

**GET /projects** → `[ { Id, Number, Name, Reference, Description, Note, Status, StartDate, EndDate, CustomerCode } ]`

**GET /projects/{number}** → `{ Id, Number, Name, Reference, Description, Note, Status, StartDate, EndDate, CustomerCode, CustomerName, TargetSalesAmount, AssociatedQuotesCount, TargetPurchasesAmount, ExcludeVAT, ActualSalesAmount, ActualPurchasesAmount, ActualSalesVATAmount, ActualPurchasesVATAmount, ActualJournalsAmount, WorkInProgressAmount }`

**GET /customers/{code}/projects** → Paginated `{ MetaData, Data: [ ...same as list ] }`

59. Promo / Subscription
Promo code endpoints `/subscription/promo` ; subscription CRUD & details `/subscription*`

60. Purchases & Purchase Orders
Purchases: CRUD `/purchases` + reverse, bulk create, assign project, email flag.
Purchase Orders: CRUD `/purchaseorders` + email flag.
Recurring Purchases: `/recurringpurchases*`

**GET /purchases** → Paginated `{ MetaData, Data: [ { Number, IssuedDate, DueDate, SupplierName, SupplierCode, SupplierReference, ProjectGrossAmount, SupplierId, Id, PaidDate, VATAmount, NetAmount, TotalPaidAmount, CISRCNetAmount, CISRCVatAmount, Status, Currency: { Name, Symbol, DisplaySymbolOnRight, Code, ExchangeRate }, HomeCurrencyGrossAmount, OverdueDays, ProjectNumber, ProjectName, TradeBorderType, FileCount, DueAmount, IsEmailSent, VATReturnId, IsCISReverseCharge, Type } ] }`

**GET /purchases/{number}** → `{ Number, IssuedDate, DueDate, SupplierName, SupplierCode, SupplierReference, GrossAmount, LineItems: [ { NominalId, ProductName, HomeCurrencyRate, ProjectName, HomeCurrencyImportDuty, DisableDisallowed, ProjectNumber, NominalName, ImportDuty, StockInfo, Number, Description, Quantity, Rate, VATLevel, VATExempt, VATAmount, NominalCode, ProductCode, TaxCode, Disallowed } ], PaymentLines: [ { BulkPaymentNumber, Permalink, PaymentProcessorEnumValue, IsPaymentCreditNote, VATReturnId, Id, Date, BulkId, BFSTransactionId, PaymentProcessor, AccountId, Note, Method, Amount } ], Permalink, AdditionalFieldValue, PreviousNumber, NextNumber, IsWhtDeductionToBeApplied, StockManagementApplicable, Id, PaidDate, VATAmount, NetAmount, TotalPaidAmount, CISRCNetAmount, CISRCVatAmount, Status, Currency, HomeCurrencyGrossAmount, OverdueDays, ProjectNumber, ProjectName, TradeBorderType, FileCount, DueAmount, IsEmailSent, VATReturnId, IsCISReverseCharge, Type }`

61. Purchase Reports & Settings
Settings: `/settings/purchaseorder`
Reports: `/reports/purchase/*`

62. Quotes & Categories / Reports
Quotes CRUD `/quotes` ; categories `/quotecategories*` ; report `/reports/quotes`

**GET /quotecategories** → `[ { Number, Name, IconId, IconType, IconColor } ]`

**GET /quotes** → Paginated `{ MetaData, Data: [ { Number, Date, CustomerCode, CustomerReference, GrossAmount, ProjectNumber, Category: { Number, Name, IconType, IconColor }, CustomerId, CustomerName, NetAmount, VATAmount, ProjectName, FileCount, IsEmailSent } ] }`

**GET /quotes/{number}** → `{ Number, Date, CustomerCode, CustomerReference, GrossAmount, ProjectNumber, Category: { IconId, Number, Name, IconType, IconColor }, HomeCurrencyGrossAmount, Currency, LineItems: [ { ProductName, HomeCurrencyRate, HomeCurrencyVATAmount, Number, Description, Quantity, Rate, VATLevel, VATExempt, VATAmount, NominalCode, ProductCode, TaxCode, Disallowed } ], SuppressAmount, PreviousNumber, NextNumber, Permalink, Addresses, DeliveryAddresses, UseCustomDeliveryAddress, CustomerId, CustomerName, NetAmount, VATAmount, ProjectName, FileCount, IsEmailSent }`

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

**GET /suppliers** → Paginated `{ MetaData, Data: [ { Id, Code, Name, UsesDefaultPdftTheme, Currency, TotalPaidAmount, OutstandingBalance, DoesSupplierHasTransactionsInVATReturn, SourceName, Address, Contacts, TradeBorderType, IsArchived, IsCISReverseCharge, ApplyWithholdingTax, WithholdingTaxReferences, IsVatRateEnabled, DefaultVatRate, VatExempt } ] }`

**GET /suppliers/{code}** → `{ Id, Code, Name, Address, DefaultPdfTheme, BankAccount: { Name, Number, SortCode }, VatNumber, PaymentMethod, DefaultNominalCode, PaymentTerms: { Type, Days }, WithholdingTaxRate, BilledNetAmount, BilledVatAmount, UniqueEntityNumber, Note, CreatedDate, LastUpdatedDate, UsesDefaultPdftTheme, Currency, TotalPaidAmount, OutstandingBalance, DoesSupplierHasTransactionsInVATReturn, SourceName, Contacts, TradeBorderType, IsArchived, IsCISReverseCharge, ApplyWithholdingTax, WithholdingTaxReferences, IsVatRateEnabled, DefaultVatRate, VatExempt }`

**GET /suppliers/{code}/statistics** → `{ FirstTransactionDate, LastTransactionDate, TotalBilled, TotalPaid, TotalDue }`

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

**GET /vat/settings/vatrates** `[MODELED → vatrates]` → `[ { VATId, VATRate, VATText } ]`

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
2026-03-23 Added response schemas for Projects, Purchases, and Suppliers endpoints.
2026-03-23 Added VAT rate response schemas; documented /countries and /vat/settings/vatrates.
2025-11-25 Reformatted dense Swagger dump into structured index for developer readability.

