# Notes REST curl

- Base: `https://api.kashflow.com/v2`
- Path shape: `/{objectType}/{objectNumber}/notes(/ {number})`
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
# List notes for an entity (e.g., customer)
curl -s -H "Authorization: Bearer $KF_TOKEN" \
  "$BASE/$OBJECT_TYPE/$OBJECT_NUMBER/notes"

# Get note by number
curl -s -H "Authorization: Bearer $KF_TOKEN" \
  "$BASE/$OBJECT_TYPE/$OBJECT_NUMBER/notes/$NUMBER"

# Create note
curl -s -X POST -H "Authorization: Bearer $KF_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "Text": "Followed up with client"
  }' \
  "$BASE/$OBJECT_TYPE/$OBJECT_NUMBER/notes"

# Update note
curl -s -X PUT -H "Authorization: Bearer $KF_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "Text": "Meeting rescheduled"
  }' \
  "$BASE/$OBJECT_TYPE/$OBJECT_NUMBER/notes/$NUMBER"

# Delete note
curl -s -X DELETE -H "Authorization: Bearer $KF_TOKEN" \
  "$BASE/$OBJECT_TYPE/$OBJECT_NUMBER/notes/$NUMBER"
```

Vars:
- `OBJECT_TYPE` one of `customers|suppliers|invoices|quotes|purchases|purchaseorders`
- `OBJECT_NUMBER` target entity number
- `NUMBER` note number
- `KF_TOKEN` session token
- `BASE=https://api.kashflow.com/v2`
