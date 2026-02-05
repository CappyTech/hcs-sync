# KashFlow API Differences: SOAP vs REST

This document summarizes the key differences between the KashFlow SOAP and REST APIs for quotes and related entities.

## 1. Data Format
- **SOAP**: XML-based, uses `<Envelope>`, `<Body>`, and nested elements.
- **REST**: JSON-based (also supports XML), uses standard HTTP verbs and URLs.

## 2. Field Names & Structure
- **SOAP**: Uses names like `InvoiceDBID`, `InvoiceNumber`, `CustomerID`, `SuppressTotal`. Structure is flat and fixed.
- **REST**: Uses names like `Id`, `Number`, `CustomerId`, `SuppressAmount`. Structure is flexible, supports nested objects (e.g., `Category`, `Currency`, `LineItems`).

## 3. Field Coverage
- **SOAP**: Limited to core invoice/quote fields. Line items are generic `<anyType />` elements.
- **REST**: Richer business logic fields, including `GrossAmount`, `NetAmount`, `VATAmount`, `Category`, `Currency`, `LineItems`, and pagination metadata.

## 4. Data Types
- **SOAP**: XML types (`int`, `string`, `dateTime`, `decimal`, `boolean`).
- **REST**: JSON types (`number`, `string`, `boolean`, `object`).

## 5. Line Items
- **SOAP**: Line items are under `<Lines>`, generic and less detailed.
- **REST**: Line items are under `LineItems`, with detailed fields (e.g., `NominalCode`, `Description`, `Quantity`, `Rate`, `VATAmount`).

## 6. Category & Currency
- **SOAP**: No explicit category or currency object; only simple fields.
- **REST**: Has nested `Category` and `Currency` objects with multiple properties.

## 7. Pagination & Metadata
- **SOAP**: No built-in pagination; returns all results in one response.
- **REST**: Supports pagination with metadata (`FirstPageUrl`, `LastPageUrl`, `NextPageUrl`, `TotalRecords`).

## 8. Operations & Protocol
- **SOAP**: Uses XML, requires a specific envelope and body structure, accessed via POST with a SOAPAction header.
- **REST**: Uses HTTP verbs (`GET`, `POST`, `PUT`, `DELETE`), standard URLs, and JSON/XML payloads.

## 9. Flexibility & Extensibility
- **SOAP**: Rigid, contract-based, less flexible for changes.
- **REST**: More flexible, easier to extend with new fields and objects.

## 10. Full Field Mapping: SOAP vs REST
| SOAP Field             | REST Field                | Notes/Type Differences                |
|------------------------|--------------------------|---------------------------------------|
| InvoiceDBID            | Id                       | number                                |
| InvoiceNumber          | Number                   | number                                |
| CustomerID             | CustomerId               | number                                |
| SuppressTotal          | SuppressAmount/SuppressNumber | REST sometimes uses SuppressNumber   |
| Paid                   | Paid                     | number                                |
| EstimateCategory       | Category                 | REST: object (Category), SOAP: string |
| ProjectID              | ProjectNumber/ProjectId  | REST: ProjectNumber (in lines), sometimes ProjectId |
| DeliveryAddress        | DeliveryAddress/Address  | REST: can be nested object            |
| CurrencyCode           | Currency.Code            | REST: Currency is an object           |
| ExchangeRate           | Currency.ExchangeRate    | REST: Currency is an object           |
| NetAmount              | NetAmount                | number                                |
| VATAmount              | VATAmount                | number                                |
| AmountPaid             | AmountPaid               | number                                |
| CustomerName           | CustomerName             | string                                |
| CustomerReference      | CustomerReference        | string                                |
| PermaLink              | Permalink                | string                                |
| UseCustomDeliveryAddress | UseCustomDeliveryAddress | boolean                               |
| Created                | CreatedDate              | date                                  |
| Updated                | LastUpdatedDate          | date                                  |
| Discount               | DiscountRate             | number                                |
| Lines                  | LineItems                | REST: array of objects, SOAP: array   |
| PaymentTerms           | PaymentTerms             | REST: object, SOAP: number            |
| VATNumber              | VATNumber                | string                                |
| IsRegisteredInEC       | IsRegisteredInEC         | boolean                               |
| IsRegisteredOutsideEC  | IsRegisteredOutsideEC    | boolean                               |
| IsArchived             | IsArchived               | boolean                               |
| Note/Notes             | Note                     | string                                |
| FileCount              | FileCount                | number (REST only)                    |
| Status                 | Status                   | string/number                         |
| FirstInvoiceDate       | FirstInvoiceDate         | date                                  |
| LastInvoiceDate        | LastInvoiceDate          | date                                  |
| FirstPurchaseDate      | FirstPurchaseDate        | date                                  |
| LastPurchaseDate       | LastPurchaseDate         | date                                  |
| OutstandingBalance     | OutstandingBalance       | number                                |
| TotalPaidAmount        | TotalPaidAmount          | number                                |
| DefaultNominalCode     | DefaultNominalCode       | number                                |
| DefaultCustomerReference | DefaultCustomerReference | string                                |
| Contacts               | Contacts                 | array                                 |
| Addresses              | Addresses                | array                                 |
| DeliveryAddresses      | DeliveryAddresses        | array                                 |
| CustomCheckBoxes       | CustomCheckBoxes         | array                                 |
| CustomTextBoxes        | CustomTextBoxes          | array                                 |
| Mobile/MobileNumber    | MobileNumber             | string                                |
| Telephone/TelephoneNumber | TelephoneNumber        | string                                |
| Fax/FaxNumber          | FaxNumber                | string                                |
| Website                | Website                  | string                                |
| Source                 | Source                   | number                                |
| CreateCustomerCodeIfDuplicate | CreateCustomerCodeIfDuplicate | boolean                    |
| CreateCustomerNameIfEmptyOrNull | CreateCustomerNameIfEmptyOrNull | boolean                |
| WHTRate                | WHTRate                  | number                                |
| ApplyWHT               | ApplyWHT                 | boolean                               |
| SubmissionDate         | SubmissionDate           | date                                  |
| TaxMonth               | TaxMonth                 | number                                |
| TaxYear                | TaxYear                  | number                                |
| ReadableString         | ReadableString           | string                                |
| Payments               | PaymentLines             | REST: array of objects                |
| CISRCNetAmount         | (no direct REST field)   | SOAP only                             |
| CISRCVatAmount         | (no direct REST field)   | SOAP only                             |
| IsCISReverseCharge     | (no direct REST field)   | SOAP only                             |
| EC                     | (no direct REST field)   | SOAP only                             |
| CurrencyID             | Currency.Id              | number                                |
| PaymentMethod          | PaymentMethod            | number (REST only)                    |
| DefaultPdfTheme        | DefaultPdfTheme          | number (REST only)                    |
| UniqueEntityNumber     | UniqueEntityNumber       | string                                |
| WithholdingTaxRate     | WithholdingTaxRate       | number (REST only)                    |
| WithholdingTaxReferences | WithholdingTaxReferences | string|null (REST only)              |
| IsWhtDeductionToBeApplied | IsWhtDeductionToBeApplied | boolean (REST only)                |
| StockManagementApplicable | StockManagementApplicable | boolean (REST only)                |
| AdditionalFieldValue   | AdditionalFieldValue     | string (REST only)                    |
| HomeCurrencyGrossAmount | HomeCurrencyGrossAmount | number (REST only)                    |
| PackingSlipPermalink   | PackingSlipPermalink     | string (REST only)                    |
| ReminderLetters        | ReminderLetters          | array (REST only)                     |
| AutomaticCreditControlEnabled | AutomaticCreditControlEnabled | boolean (REST only)         |
| EmailCount             | EmailCount               | number (REST only)                    |
| InvoiceInECMemberState | InvoiceInECMemberState   | boolean (REST only)                   |
| InvoiceOutsideECMemberState | InvoiceOutsideECMemberState | boolean (REST only)             |
| SuppressNumber         | SuppressNumber           | number (REST only)                    |
| UpdateCustomerAddress  | UpdateCustomerAddress    | boolean (REST only)                   |
| UpdateCustomerDeliveryAddress | UpdateCustomerDeliveryAddress | boolean (REST only)         |
| Category (object)      | Category (object)        | REST only, richer than SOAP           |
| StatusName             | StatusName               | string (REST only)                    |
| AssociatedQuotesCount  | AssociatedQuotesCount    | number (REST only)                    |
| ActualJournalsAmount   | ActualJournalsAmount     | number (REST only)                    |
| ActualPurchasesAmount  | ActualPurchasesAmount    | number (REST only)                    |
| ActualSalesAmount      | ActualSalesAmount        | number (REST only)                    |
| TargetPurchasesAmount  | TargetPurchasesAmount    | number (REST only)                    |
| TargetSalesAmount      | TargetSalesAmount        | number (REST only)                    |
| ActualPurchasesVATAmount | ActualPurchasesVATAmount | number (REST only)                  |
| ActualSalesVATAmount   | ActualSalesVATAmount     | number (REST only)                    |
| WorkInProgressAmount   | WorkInProgressAmount     | number (REST only)                    |
| ExcludeVAT             | ExcludeVAT               | number (REST only)                    |

# KashFlow SOAP Models (JSON Overview)

The following are the main SOAP models used in the legacy system (see `mongoose/models/mongoose/SOAP/`). Each model is shown in a JSON-like format for clarity and comparison with REST resources.

## customer.js
```json
{
  "uuid": "string",
  "CustomerID": "number",
  "Code": "string",
  "Name": "string",
  "Contact": "string",
  "Telephone": "string",
  "Mobile": "string",
  "Email": "string",
  "Address1": "string",
  "Address2": "string",
  "Address3": "string",
  "Postcode": "string",
  "CountryName": "string",
  "Website": "string",
  "Notes": "string",
  "Discount": "number",
  "Created": "date",
  "Updated": "date"
}
```

## invoice.js
```json
{
  "uuid": "string",
  "InvoiceDBID": "number",
  "InvoiceNumber": "number",
  "InvoiceDate": "date",
  "DueDate": "date",
  "Customer": "string",
  "CustomerID": "number",
  "Paid": "number",
  "CustomerReference": "string",
  "EstimateCategory": "string",
  "SuppressTotal": "number",
  "ProjectID": "number",
  "CurrencyCode": "string",
  "ExchangeRate": "number",
  "NetAmount": "number",
  "VATAmount": "number",
  "AmountPaid": "number",
  "CustomerName": "string",
  "PermaLink": "string",
  "DeliveryAddress": {
    "Name": "string",
    "Line1": "string",
    "Line2": "string",
    "Line3": "string",
    "Line4": "string",
    "PostCode": "string",
    "CountryName": "string",
    "CountryCode": "string"
  },
  "UseCustomDeliveryAddress": "boolean",
  "CISRCNetAmount": "number",
  "CISRCVatAmount": "number",
  "IsCISReverseCharge": "boolean",
  "Lines": [
    {
      "LineID": "number",
      "Quantity": "number|null",
      "Description": "string|null",
      "Rate": "number|null",
      "ChargeType": "string|null",
      "ChargeTypeName": "string|null",
      "VatRate": "number|null",
      "VatAmount": "number|null",
      "ProductID": "string|null",
      "Sort": "number|null",
      "ProjID": "string|null"
    }
  ]
}
```

## project.js
```json
{
  "uuid": "string",
  "ID": "number",
  "Number": "number",
  "Name": "string",
  "Reference": "string",
  "Description": "string",
  "Date1": "date",
  "Date2": "date",
  "CustomerID": "number",
  "Status": "number"
}
```

## quote.js
```json
{
  "uuid": "string",
  "InvoiceDBID": "number",
  "InvoiceNumber": "number",
  "InvoiceDate": "date",
  "DueDate": "date",
  "Customer": "string",
  "CustomerID": "number",
  "Paid": "number",
  "CustomerReference": "string",
  "EstimateCategory": "string",
  "SuppressTotal": "number",
  "ProjectID": "number",
  "CurrencyCode": "string",
  "ExchangeRate": "number",
  "NetAmount": "number",
  "VATAmount": "number",
  "AmountPaid": "number",
  "CustomerName": "string",
  "PermaLink": "string",
  "DeliveryAddress": {
    "Name": "string",
    "Line1": "string",
    "Line2": "string",
    "Line3": "string",
    "Line4": "string",
    "PostCode": "string",
    "CountryName": "string",
    "CountryCode": "string"
  },
  "UseCustomDeliveryAddress": "boolean",
  "CISRCNetAmount": "number",
  "CISRCVatAmount": "number",
  "IsCISReverseCharge": "boolean",
  "Lines": [
    {
      "LineID": "number",
      "Quantity": "number",
      "Description": "string",
      "Rate": "number",
      "ChargeType": "string",
      "ChargeTypeName": "string",
      "VatRate": "number",
      "VatAmount": "number",
      "ProductID": "string",
      "Sort": "number",
      "ProjID": "string"
    }
  ]
}
```

## receipt.js
```json
{
  "uuid": "string",
  "InvoiceDBID": "number",
  "InvoiceNumber": "number",
  "InvoiceDate": "date",
  "DueDate": "date",
  "Customer": "string",
  "CustomerID": "number",
  "Paid": "number",
  "CustomerReference": "string",
  "EstimateCategory": "string",
  "ProjectID": "number",
  "CurrencyCode": "string",
  "ExchangeRate": "number",
  "NetAmount": "number",
  "VATAmount": "number",
  "AmountPaid": "number",
  "CustomerName": "string",
  "PermaLink": "string",
  "DeliveryAddress": "object",
  "UseCustomDeliveryAddress": "boolean",
  "CISRCNetAmount": "number",
  "CISRCVatAmount": "number",
  "IsCISReverseCharge": "boolean",
  "ReadableString": "string",
  "SubmissionDate": "date",
  "TaxMonth": "number",
  "TaxYear": "number",
  "Payments": ["object"],
  "Lines": [
    {
      "LineID": "number",
      "Quantity": "number|null",
      "Description": "string|null",
      "Rate": "number|null",
      "ChargeType": "string|null",
      "ChargeTypeName": "string|null",
      "VatRate": "number|null",
      "VatAmount": "number|null",
      "ProductID": "string|null",
      "Sort": "number|null",
      "ProjID": "string|null"
    }
  ]
}
```

## supplier.js
```json
{
  "uuid": "string",
  "SupplierID": "number",
  "Code": "string",
  "Name": "string",
  "Contact": "string",
  "Mobile": "string",
  "Fax": "string",
  "Address1": "string",
  "Address2": "string",
  "Address3": "string",
  "Address4": "string",
  "PostCode": "string",
  "Telephone": "string",
  "Website": "string",
  "Email": "string",
  "Created": "date",
  "Updated": "date",
  "EC": "number",
  "VATNumber": "string",
  "Notes": "string",
  "CurrencyID": "number",
  "PaymentTerms": "number",
  "ContactTitle": "string",
  "ContactFirstName": "string",
  "ContactLastName": "string",
  "TradeBorderType": "number",
  "IsSubcontractor": "boolean",
  "CISRate": "string",
  "CISNumber": "string|null"
}
```

# KashFlow REST API Overview

### Main Endpoints
- `GET /customers` – Fetch customers
- `GET /suppliers` – Fetch suppliers
- `GET /invoices` – Fetch invoices
- `GET /quotes` – Fetch quotes
- `GET /purchases` – Fetch purchases
- `GET /projects` – Fetch projects

# KashFlow REST Models

## Customer (REST)
```json
{
  "Id": "number",
  "Code": "string",
  "Name": "string",
  "DisplayName": "string",
  "Note": "string",
  "CreatedDate": "date",
  "LastUpdatedDate": "date",
  "FirstInvoiceDate": "date",
  "LastInvoiceDate": "date",
  "InvoiceCount": "number",
  "InvoicedNetAmount": "number",
  "InvoicedVATAmount": "number",
  "OutstandingBalance": "number",
  "TotalPaidAmount": "number",
  "DiscountRate": "number",
  "DefaultNominalCode": "number",
  "DefaultCustomerReference": "string",
  "VATNumber": "string",
  "IsRegisteredInEC": "boolean",
  "IsRegisteredOutsideEC": "boolean",
  "IsArchived": "boolean",
  "ReceivesWholesalePricing": "boolean",
  "ApplyWHT": "boolean",
  "WHTRate": "number",
  "PaymentTerms": { "Days": "number", "Type": "string" },
  "Currency": {
    "Code": "string",
    "ExchangeRate": "number",
    "DisplayOnRight": "boolean",
    "Name": "string",
    "Symbol": "string"
  },
  "Contacts": [{ ... }],
  "Addresses": [{ ... }],
  "DeliveryAddresses": [{ ... }],
  "CustomCheckBoxes": [{ "Name": "string", "Value": "string" }],
  "CustomTextBoxes": [{ "Name": "string", "Value": "string" }],
  "Email": "string",
  "EmailTemplateNumber": "number",
  "FaxNumber": "string",
  "MobileNumber": "string",
  "TelephoneNumber": "string",
  "UniqueEntityNumber": "string",
  "Website": "string",
  "ShowDiscount": "boolean",
  "Source": "number",
  "CreateCustomerCodeIfDuplicate": "boolean",
  "CreateCustomerNameIfEmptyOrNull": "boolean"
}
```

## Invoice (REST)
```json
{
  "Id": "number",
  "Number": "number",
  "CustomerId": "number",
  "CustomerName": "string",
  "CustomerReference": "string",
  "Currency": {
    "Code": "string",
    "ExchangeRate": "number",
    "Id": "number",
    "Name": "string",
    "Symbol": "string",
    "DisplaySymbolOnRight": "boolean"
  },
  "NetAmount": "number",
  "GrossAmount": "number",
  "VATAmount": "number",
  "AmountPaid": "number",
  "TotalPaidAmount": "number",
  "Paid": "number",
  "IssuedDate": "date",
  "DueDate": "date",
  "PaidDate": "date",
  "LastPaymentDate": "date",
  "Status": "string",
  "LineItems": [{ ... }],
  "PaymentLines": [{ ... }],
  "DeliveryAddress": { ... },
  "Address": { ... },
  "UseCustomDeliveryAddress": "boolean",
  "Permalink": "string",
  "PackingSlipPermalink": "string",
  "ReminderLetters": [{ ... }],
  "PreviousNumber": "number",
  "NextNumber": "number",
  "OverdueDays": "number",
  "AutomaticCreditControlEnabled": "boolean",
  "CustomerDiscount": "number",
  "EmailCount": "number",
  "InvoiceInECMemberState": "boolean",
  "InvoiceOutsideECMemberState": "boolean",
  "SuppressNumber": "number",
  "UpdateCustomerAddress": "boolean",
  "UpdateCustomerDeliveryAddress": "boolean",
  "VATNumber": "string"
}
```

## Project (REST)
```json
{
  "Id": "number",
  "Number": "number",
  "Name": "string",
  "Description": "string",
  "Reference": "string",
  "CustomerCode": "string",
  "CustomerName": "string",
  "StartDate": "date",
  "EndDate": "date",
  "Status": "number",
  "StatusName": "string",
  "Note": "string",
  "ActualJournalsAmount": "number",
  "ActualPurchasesAmount": "number",
  "ActualSalesAmount": "number",
  "TargetPurchasesAmount": "number",
  "TargetSalesAmount": "number",
  "ActualPurchasesVATAmount": "number",
  "ActualSalesVATAmount": "number",
  "WorkInProgressAmount": "number",
  "ExcludeVAT": "number",
  "AssociatedQuotesCount": "number"
}
```

## Quote (REST)
```json
{
  "Id": "number",
  "Number": "number",
  "CustomerId": "number",
  "CustomerName": "string",
  "Date": "date",
  "GrossAmount": "number",
  "NetAmount": "number",
  "VATAmount": "number",
  "CustomerReference": "string",
  "LineItems": [{ ... }],
  "Permalink": "string",
  "PreviousNumber": "number",
  "NextNumber": "number",
  "Status": "string",
  "Category": {
    "IconColor": "string|null",
    "IconId": "number",
    "Name": "string|null",
    "Number": "number",
    "IconType": "string|null"
  },
  "Currency": {
    "Code": "string",
    "ExchangeRate": "number",
    "DisplaySymbolOnRight": "boolean",
    "Name": "string",
    "Symbol": "string"
  },
  "CustomerCode": "string"
}
```

## Supplier (REST)
```json
{
  "Id": "number",
  "Code": "string",
  "Name": "string",
  "Note": "string",
  "CreatedDate": "date",
  "LastUpdatedDate": "date",
  "FirstPurchaseDate": "date",
  "LastPurchaseDate": "date",
  "OutstandingBalance": "number",
  "TotalPaidAmount": "number",
  "DefaultNominalCode": "number",
  "VATNumber": "string",
  "IsRegisteredInEC": "boolean",
  "IsArchived": "boolean",
  "PaymentTerms": { "Days": "number", "Type": "string" },
  "Currency": {
    "Code": "string",
    "DisplaySymbolOnRight": "boolean",
    "ExchangeRate": "number",
    "Name": "string",
    "Symbol": "string"
  },
  "Contacts": [{ ... }],
  "Address": { ... },
  "DeliveryAddresses": [{ ... }],
  "DefaultPdfTheme": "number",
  "PaymentMethod": "number",
  "CreateSupplierCodeIfDuplicate": "boolean",
  "CreateSupplierNameIfEmptyOrNull": "boolean",
  "UniqueEntityNumber": "string",
  "VatNumber": "string",
  "WithholdingTaxRate": "number",
  "WithholdingTaxReferences": "string|null"
}
```

## Purchase (REST)
```json
{
  "Id": "number",
  "Number": "number",
  "SupplierId": "number",
  "SupplierCode": "string",
  "SupplierName": "string",
  "SupplierReference": "string",
  "Currency": {
    "Code": "string",
    "DisplaySymbolOnRight": "boolean",
    "ExchangeRate": "number",
    "Name": "string",
    "Symbol": "string"
  },
  "DueDate": "date",
  "GrossAmount": "number",
  "HomeCurrencyGrossAmount": "number",
  "IssuedDate": "date",
  "FileCount": "number",
  "LineItems": [{ ... }],
  "NetAmount": "number",
  "NextNumber": "number",
  "OverdueDays": "number",
  "PaidDate": "date|null",
  "PaymentLines": [{ ... }],
  "Permalink": "string",
  "PreviousNumber": "number",
  "PurchaseInECMemberState": "boolean",
  "Status": "string",
  "StockManagementApplicable": "boolean",
  "TotalPaidAmount": "number",
  "VATAmount": "number",
  "AdditionalFieldValue": "string",
  "IsWhtDeductionToBeApplied": "boolean",
  "ReadableString": "string",
  "SubmissionDate": "date",
  "TaxMonth": "number",
  "TaxYear": "number"
}
```

---

## Migration Focus: Code Usage, Not API Operations

This migration guide is designed to help developers update their code to use the new REST-style data models, rather than to interact directly with the KashFlow REST API. The focus is on:
- Updating model definitions and field access patterns in code
- Handling changes in field names, types, and nested structures
- Adapting business logic to new model shapes and validation rules
- Ensuring compatibility with data provided in REST format, regardless of how it is sourced

Direct API operations (Create, Update, Delete) are not covered, as the migration does not involve making REST calls to KashFlow. Instead, the guide supports refactoring code to work with REST-style data objects, whether loaded from files, services, or other sources.

---