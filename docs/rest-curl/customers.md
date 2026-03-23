# Customers REST curl

- Base: `https://api.kashflow.com/v2`
- Session: auto-fetch KF session token with username/password + memorable chars

```bash
# --- Auth bootstrap (set creds and fetch KF token) ---
# URL: https://api.kashflow.com/v2/sessiontoken ; Methods: GET/POST/PUT/DELETE ; Responses: JSON or XML
BASE=${BASE:-https://api.kashflow.com/v2}
KF_USER="$KF_USER"      # e.g. user@example.com
KF_PASS="$KF_PASS"      # account password

# Step 1: request temporary token (POST username+password)
AUTH_RESP=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"username\":\"$KF_USER\",\"password\":\"$KF_PASS\"}" \
  "$BASE/sessiontoken")

# Extract tempToken and required character positions (typically 3 positions)
TEMPTOKEN=$(echo "$AUTH_RESP" | python -c "import sys,json;print(json.load(sys.stdin).get('tempToken',''))")
POS=$(echo "$AUTH_RESP" | python -c "import sys,json;print(','.join(map(str,json.load(sys.stdin).get('requiredChars',[]))))")
KF_MEMPOS1=${KF_MEMPOS1:-$(echo $POS | cut -d, -f1)}
KF_MEMPOS2=${KF_MEMPOS2:-$(echo $POS | cut -d, -f2)}
KF_MEMPOS3=${KF_MEMPOS3:-$(echo $POS | cut -d, -f3)}

# Provide the characters (case-insensitive) at those positions from the memorable word
# e.g. if memorable is "pineapple" and positions are 3,4,6 then chars are N,E,P
# Export KF_MEMCHAR1/2/3 accordingly before running.

# Step 2: exchange temp token for session token (PUT)
KF_TOKEN=$(curl -s -X PUT -H "Content-Type: application/json" \
  -d "{\"tempToken\":\"$TEMPTOKEN\",\"chars\":{\"$KF_MEMPOS1\":\"$KF_MEMCHAR1\",\"$KF_MEMPOS2\":\"$KF_MEMCHAR2\",\"$KF_MEMPOS3\":\"$KF_MEMCHAR3\"}}" \
  "$BASE/sessiontoken" | python -c "import sys,json;print(json.load(sys.stdin).get('sessionToken',''))")

# Optional: swap an External Token for a Session Token (GET), if issued
# EXTERNAL_TOKEN must be set; uncomment to use
# KF_TOKEN=$(curl -s -G "$BASE/sessiontoken" --data-urlencode "token=$EXTERNAL_TOKEN" \
#  | python -c "import sys,json;print(json.load(sys.stdin).get('sessionToken',''))")

# Optional: revoke session token immediately (DELETE)
# curl -s -X DELETE "$BASE/sessiontoken/$KF_TOKEN"
```

```bash
# List customers
curl -s -H "Authorization: Bearer $KF_TOKEN" \
  "$BASE/customers"

# Get customer by code
curl -s -H "Authorization: Bearer $KF_TOKEN" \
  "$BASE/customers/$CODE"

# Search customers by query
curl -s -H "Authorization: Bearer $KF_TOKEN" \
  "$BASE/customers/search?query=$QUERY"

# Create customer
curl -s -X POST -H "Authorization: Bearer $KF_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "Code": "C0001",
    "Name": "Acme Ltd",
    "Email": "accounts@acme.test"
  }' \
  "$BASE/customers"

# Update customer
curl -s -X PUT -H "Authorization: Bearer $KF_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "Name": "Acme Ltd (Updated)"
  }' \
  "$BASE/customers/$CODE"

# Delete customer
curl -s -X DELETE -H "Authorization: Bearer $KF_TOKEN" \
  "$BASE/customers/$CODE"
```

Env vars to set:
- `BASE=https://api.kashflow.com/v2`
- `KF_USER`, `KF_PASS`
- `KF_MEMPOS1`, `KF_MEMPOS2`, `KF_MEMPOS3` (if not auto-read from Step 1)
- `KF_MEMCHAR1`, `KF_MEMCHAR2`, `KF_MEMCHAR3`
- `CODE` (customer code)
- `QUERY` (search term)
