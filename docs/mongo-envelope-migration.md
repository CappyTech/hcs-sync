# Mongo migration: flatten legacy envelope docs

This repo previously wrote MongoDB documents in an "envelope" shape:

```js
{ _id, code, syncedAt, data: { ...kashflowFields } }
```

It now writes KashFlow fields at the document root (no `data` field), so list endpoints like `/customers` and `/suppliers` show real fields.

## One-time migration (per collection)

There are two options:

1) Automatic (recommended): set `MONGO_MIGRATE_ENVELOPES=1` and run a sync. The app will run the migration once per collection the first time it upserts into it.
2) Manual: run the update pipeline below in the Mongo shell.

Run this for each affected collection (e.g. `customers`, `suppliers`) in the Mongo shell.

Example for `suppliers`:

```js
db.suppliers.updateMany(
  { data: { $type: "object" } },
  [
    {
      $set: {
        _tmpCode: { $ifNull: ["$data.Code", "$code"] },
        _tmpSyncedAt: { $ifNull: ["$syncedAt", "$updatedAt"] },
      },
    },
    {
      $replaceRoot: {
        newRoot: {
          $mergeObjects: [
            "$data",
            {
              _id: "$_id",
              Code: "$_tmpCode",
              code: "$_tmpCode",
              syncedAt: "$_tmpSyncedAt",
            },
          ],
        },
      },
    },
    { $unset: ["_tmpCode", "_tmpSyncedAt"] },
  ]
);
```

Repeat for `customers`:

```js
db.customers.updateMany(
  { data: { $type: "object" } },
  [
    {
      $set: {
        _tmpCode: { $ifNull: ["$data.Code", "$code"] },
        _tmpSyncedAt: { $ifNull: ["$syncedAt", "$updatedAt"] },
      },
    },
    {
      $replaceRoot: {
        newRoot: {
          $mergeObjects: [
            "$data",
            {
              _id: "$_id",
              Code: "$_tmpCode",
              code: "$_tmpCode",
              syncedAt: "$_tmpSyncedAt",
            },
          ],
        },
      },
    },
    { $unset: ["_tmpCode", "_tmpSyncedAt"] },
  ]
);
```

## Verify

After migration (and after a sync with the updated code), sample documents should look like:

- `Name`, `Code`, etc. at top-level
- `syncedAt` at top-level
- no `data` field
