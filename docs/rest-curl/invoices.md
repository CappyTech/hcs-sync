# Invoices REST curl

- Base: `https://api.kashflow.com/v2`
- Session: auto-fetch KF session token with username/password + memorable chars

```bash
# --- Auth bootstrap ---
BASE=${BASE:-https://api.kashflow.com/v2}
KF_USER="$KF_USER"; KF_PASS="$KF_PASS"
AUTH_RESP=$(curl -s -X POST -H "Content-Type: application/json" -d "{\"username\":\"$KF_USER\",\"password\":\"$KF_PASS\"}" "$BASE/sessiontoken")
TEMPTOKEN=$(echo "$AUTH_RESP" | python -c "import sys,json;print(json.load(sys.stdin).get('tempToken',''))")
POS=$(echo "$AUTH_RESP" | python -c "import sys,json;print(','.join(map(str,json.load(sys.stdin).get('requiredChars',[]))))")
KF_MEMPOS1=${KF_MEMPOS1:-$(echo $POS | cut -d, -f1)}
KF_MEMPOS2=${KF_MEMPOS2:-$(echo $POS | cut -d, -f2)}
KF_MEMPOS3=${KF_MEMPOS3:-$(echo $POS | cut -d, -f3)}
KF_TOKEN=$(curl -s -X PUT -H "Content-Type: application/json" -d "{\"tempToken\":\"$TEMPTOKEN\",\"chars\":{\"$KF_MEMPOS1\":\"$KF_MEMCHAR1\",\"$KF_MEMPOS2\":\"$KF_MEMCHAR2\",\"$KF_MEMPOS3\":\"$KF_MEMCHAR3\"}}" "$BASE/sessiontoken" | python -c "import sys,json;print(json.load(sys.stdin).get('sessionToken',''))")
```

```bash
# List invoices
curl -s -H "Authorization: Bearer $KF_TOKEN" \
  "$BASE/invoices"

# Get invoice by number
curl -s -H "Authorization: Bearer $KF_TOKEN" \
  "$BASE/invoices/$NUMBER"

# Create invoice (minimal example)
curl -s -X POST -H "Authorization: Bearer $KF_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "CustomerCode": "C0001",
    "InvoiceDate": "2025-01-15",
    "Lines": [
      { "Description": "Service", "Quantity": 1, "UnitPrice": 100 }
    ]
  }' \
  "$BASE/invoices"

# Update invoice
curl -s -X PUT -H "Authorization: Bearer $KF_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "Notes": "Updated notes"
  }' \
  "$BASE/invoices/$NUMBER"

# Delete invoice
curl -s -X DELETE -H "Authorization: Bearer $KF_TOKEN" \
  "$BASE/invoices/$NUMBER"
```

Vars: `BASE`, `KF_TOKEN`, `NUMBER`