# Wine Order Count Static Web App

This folder contains a standalone HTML/CSS/JavaScript version of Wine Order Count for GitHub Pages.

## Files

- `index.html` - app shell
- `catalog.js` - built-in curated product catalog and fixed category/order mapping
- `styles.css` - purple themed UI
- `firebase-config.js` - Firebase App and Firestore browser sync adapter
- `app.js` - local storage, XLSX/CSV import, ordering logic, CSV export
- `service-worker.js` - basic offline cache
- `firestore.rules` - testing-only Firestore rules example
- `xlsx.full.min.js` - local SheetJS build for browser XLSX parsing

`index.html` loads `xlsx.full.min.js` before `app.js`. If the local file is missing, it attempts a CDN fallback from jsDelivr. For restricted work laptops, keep `xlsx.full.min.js` beside `index.html` so XLSX uploads work without relying on the CDN.

## What Runs Locally

The app runs as a static GitHub Pages site. Uploaded files are parsed in the browser. Data is saved locally first, then synced to Firebase Firestore under the selected store number when Firebase is available.

Saved locally:

- built-in catalog inventory counts and edits
- inventory products
- edited SKU/description overrides
- deleted built-in item hide-list
- old-to-new SKU aliases for matching edited items
- Front unit counts
- Backstock case counts
- notes and order overrides
- on-sale flags and the Show Only Sale Items filter
- uploaded sales sessions
- matched and unmatched sales rows
- deduction history
- settings

## Firebase Sync

Use the **Store** dropdown at the top of the app to choose the active store number. All inventory counts, sales sessions, product edits, deleted items, sale flags, recommendations, deductions, and settings are saved under:

```text
stores/{storeNumber}/data/appState
```

The app also keeps a per-store browser cache:

```text
wine-order-count-static-v1_store_{storeNumber}
```

If Firebase is unavailable, the app continues in local mode and syncs again when the browser comes back online.

The **Save Progress** button now writes a local backup first and then waits for the Firestore write to finish. A successful manual save shows **Project saved to Firebase**. If Firestore is unavailable or rejects the write, the app keeps the local backup and shows **Firebase save failed. Project saved locally only.**

### Firestore Testing Rules

These rules are for personal testing only. They are public and unauthenticated, so they are not safe for production or public sharing. Add Firebase Authentication before sharing the app widely.

```text
service cloud.firestore {
  match /databases/{database}/documents {
    match /stores/{storeNumber}/{document=**} {
      allow read, write: if true;
    }
  }
}
```

## Publish on GitHub Pages

1. Create a GitHub repository or open your existing repository.
2. Copy this `docs` folder into the repository root.
3. Commit and push the files.
4. In GitHub, go to **Settings > Pages**.
5. Under **Build and deployment**, choose:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/docs`
6. Click **Save**.
7. GitHub will show the Pages URL after the deploy finishes.

The app will be available at a URL similar to:

```text
https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/
```

## Local Testing

You can open `index.html` directly in a browser for basic testing. For service-worker/offline testing, serve the folder over a local static server:

```powershell
cd docs
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

## Import Expectations

The app includes the curated product catalog automatically. Inventory file import is optional and is used to merge count data into matching catalog products.
Inventory rows can also be edited or deleted directly in the app. Deleted built-in catalog items are hidden locally, not removed from the source code, and can be restored from **Settings > Restore Deleted Inventory Items**.

Inventory files should include headers like:

- `JDE/UPC`
- `Description`
- optional `Front`
- optional `Backstock`

Sales files can be XLSX or CSV. The parser looks for common headers like:

- `JDE/UPC`, `UPC`, `JDE`, `Product Code`
- `Description`, `Product`, `Product Name`
- `Units Sold`, `Units`, `Sold`
- `Pack`, `Size`, `Package`

If headers are missing, the sales parser also supports the app's legacy column layout:

- Column B: JDE/UPC or product identifier
- Column C: pack/product text
- Column E: units sold

## Exports

The app exports CSV files fully in the browser:

- inventory levels
- order recommendations

No data is uploaded during export.
