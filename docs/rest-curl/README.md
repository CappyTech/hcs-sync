# REST Curl Scripts (Windows)

These batch scripts help you quickly call KashFlow REST endpoints using a session token. All scripts are currently non-destructive (GET-only) and request JSON for safe inspection.

## Prerequisites
- Windows PowerShell 5.1 (default shell) and `curl` available
- Base URL and credentials to obtain a session token

## Authentication Flow
- `_auth_template.bat` bootstraps a session using the two-step `/sessiontoken` flow and sets `KF_TOKEN` for the current run.
- Scripts call this template first, then issue GET requests with `Authorization: Bearer %KF_TOKEN%` and `Accept: application/json`.
 - If `KF_USER` / `KF_PASS` / memory chars (`KF_MEMCHAR1/2/3`) are not set, you will be prompted interactively. Password input is not masked.

## Usage
Run any script from PowerShell. Set identifiers as needed.

```powershell
# Customers
cd "c:\Users\user\Documents\GitHub\hcs-app\docs\rest-curl";
./customers.bat

# Suppliers
./suppliers.bat

# Invoices (set NUMBER before calling)
$env:NUMBER = 1001; ./invoices.bat

# Purchases (set NUMBER before calling)
$env:NUMBER = 2001; ./purchases.bat

# Projects (set NUMBER before calling)
$env:NUMBER = 3001; ./projects.bat

# Quotes (set NUMBER before calling)
$env:NUMBER = 4001; ./quotes.bat

# Nominals (set CODE before calling)
$env:CODE = 4000; ./nominals.bat

# Notes (set OBJECT_TYPE, OBJECT_NUMBER, and optionally NUMBER)
$env:OBJECT_TYPE = "customers"; $env:OBJECT_NUMBER = 123; ./notes.bat
```

## Environment Variables
- `BASE`: Optional override of the API base URL (default is set in `_auth_template.bat`).
- `NUMBER` / `CODE`: Resource identifiers for entity-specific lookups.
- `OBJECT_TYPE`: One of `customers|suppliers|invoices|quotes|purchases|purchaseorders` for notes.
- `OBJECT_NUMBER`: The entity number for notes.

## Safety
- Scripts are GET-only and set `Accept: application/json`.
- No create/update/delete operations are included.

## Tips
- If your environment requires a proxy or different base URL, set `BASE` in PowerShell before running: `Set-Item Env:BASE "https://api.example.com"`.
- To inspect raw output, remove `-s` from the `curl` lines in a local copy.

## Interactive Browser
Use `interactive.bat` (wrapper around `interactive.ps1`) for an in-terminal menu. If no token is provided, the script will guide you through the two-step session token process:
- Choose a resource (customers, suppliers, invoices, purchases, projects, quotes, nominals)
- List items with index, key, and description
- Enter either the displayed index or the actual key/code to fetch detailed JSON

Example:
```powershell
cd "c:\Users\user\Documents\GitHub\hcs-app\docs\rest-curl";
./interactive.bat  # or: powershell -ExecutionPolicy Bypass -File ./interactive.ps1 -Base $env:BASE
```

To force re-auth even if `KF_TOKEN` is set:
```powershell
powershell -ExecutionPolicy Bypass -File .\interactive.ps1 -ForceAuth
```

### Paging
The interactive script supports paging of large lists. Default `PageSize` is 10.
Set a custom size:
```powershell
powershell -ExecutionPolicy Bypass -File .\interactive.ps1 -PageSize 25
```
In the list view use:
- `n` : next page
- `p` : previous page
- `a` : show all items
- `q` : return to menu
- `index` or `code` : view detail for that record

Add `-DebugList` to print raw JSON snippet if list extraction fails.

Notes:
- All operations remain GET-only.
- Property mapping used: `Code`, `InvoiceNumber`, `PurchaseNumber`, `Number`, `QuoteNumber`, `Description`, `Name`, `CustomerCode`, `SupplierCode`.
