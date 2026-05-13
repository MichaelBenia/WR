const STORAGE_KEY = "wine-order-count-static-v1";
const STORE_REGISTRY_KEY = "wine-order-count-store-registry-v1";
const DEFAULT_STORE_NUMBER = "default";
const FIREBASE_SAVE_DEBOUNCE_MS = 900;
const DEFAULT_TARGET_WEEKS = 2;
const SKU_HEADER_ALIASES = [
  "jde",
  "sku",
  "upc",
  "jde/upc",
  "jde/upc #",
  "jde upc",
  "jde upc #",
  "jde #",
  "upc #",
  "sku #",
  "item number",
  "product number",
  "sku / id",
  "sku/id",
  "id",
  "barcode",
  "product code",
];

const CATEGORY_CONFIG = CATEGORY_ORDER.map(name => ({
  name,
  upcs: PRODUCT_CATALOG
    .filter(product => product.category === name)
    .map(product => product.sku),
}));

const categoryByUpc = new Map();
const orderByUpc = new Map();
CATEGORY_CONFIG.forEach((category, categoryIndex) => {
  category.upcs.forEach((upc, itemIndex) => {
    const key = normalizeUpc(upc);
    categoryByUpc.set(key, { name: category.name, categoryIndex, itemIndex });
    orderByUpc.set(key, `${String(categoryIndex).padStart(2, "0")}:${String(itemIndex).padStart(3, "0")}`);
  });
});

const dom = {
  salesInput: document.getElementById("salesFileInput"),
  inventoryInput: document.getElementById("inventoryFileInput"),
  uploadSalesButton: document.getElementById("uploadSalesButton"),
  uploadInventoryButton: document.getElementById("uploadInventoryButton"),
  storeSelect: document.getElementById("storeSelect"),
  addStoreButton: document.getElementById("addStoreButton"),
  currentStoreText: document.getElementById("currentStoreText"),
  syncStatusText: document.getElementById("syncStatusText"),
  saveProgressButton: document.getElementById("saveProgressButton"),
  exportInventoryButton: document.getElementById("exportInventoryButton"),
  exportOrdersButton: document.getElementById("exportOrdersButton"),
  settingsButton: document.getElementById("settingsButton"),
  statusBanner: document.getElementById("statusBanner"),
  lastSavedText: document.getElementById("lastSavedText"),
  inventorySummary: document.getElementById("inventorySummary"),
  orderingSummary: document.getElementById("orderingSummary"),
  inventoryTable: document.getElementById("inventoryTable"),
  orderingTable: document.getElementById("orderingTable"),
  unmatchedList: document.getElementById("unmatchedList"),
  applyDeductionButton: document.getElementById("applyDeductionButton"),
  deductionStatus: document.getElementById("deductionStatus"),
  toast: document.getElementById("toast"),
  targetWeeksInput: document.getElementById("targetWeeksInput"),
  clearSalesButton: document.getElementById("clearSalesButton"),
  clearInventoryButton: document.getElementById("clearInventoryButton"),
  clearSaleFlagsButton: document.getElementById("clearSaleFlagsButton"),
  restoreDeletedItemsButton: document.getElementById("restoreDeletedItemsButton"),
  clearAllButton: document.getElementById("clearAllButton"),
  saleOnlyToggle: document.getElementById("saleOnlyToggle"),
  settingsExportInventoryButton: document.getElementById("settingsExportInventoryButton"),
  settingsExportOrdersButton: document.getElementById("settingsExportOrdersButton"),
};

let storeRegistry = loadStoreRegistry();
let currentStoreNumber = storeRegistry.currentStore;
let state = loadState(currentStoreNumber);
let saveTimer = null;
let firebaseSaveTimer = null;
let editingProductId = null;
let syncStatus = "Local only";
let isSwitchingStore = false;

bindEvents();
render();
registerServiceWorker();
initializeFirebaseSync();

function defaultState() {
  return {
    storeNumber: currentStoreNumber || DEFAULT_STORE_NUMBER,
    inventory: { products: catalogProducts() },
    productOverrides: {},
    deletedItems: [],
    skuAliases: {},
    sales: { sessions: [], activeSessionId: null },
    processing: {
      matched: [],
      unmatched: [],
      deductions: [],
      recommendations: [],
    },
    settings: { targetWeeks: DEFAULT_TARGET_WEEKS, showSaleOnly: false },
    lastSaved: null,
  };
}

function loadStoreRegistry() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_REGISTRY_KEY) || "{}");
    const stores = [...new Set((parsed.stores || [DEFAULT_STORE_NUMBER]).map(cleanText).filter(Boolean))];
    const currentStore = cleanText(parsed.currentStore) || stores[0] || DEFAULT_STORE_NUMBER;
    if (!stores.includes(currentStore)) stores.unshift(currentStore);
    return { stores, currentStore };
  } catch {
    return { stores: [DEFAULT_STORE_NUMBER], currentStore: DEFAULT_STORE_NUMBER };
  }
}

function saveStoreRegistry() {
  localStorage.setItem(STORE_REGISTRY_KEY, JSON.stringify({
    stores: storeRegistry.stores,
    currentStore: currentStoreNumber,
  }));
}

function storageKeyForStore(storeNumber) {
  const safeStore = encodeURIComponent(cleanText(storeNumber) || DEFAULT_STORE_NUMBER);
  return `${STORAGE_KEY}_store_${safeStore}`;
}

function migrateLegacyStorageIfNeeded(storeNumber) {
  if (storeNumber !== DEFAULT_STORE_NUMBER) return;
  const storeKey = storageKeyForStore(storeNumber);
  if (localStorage.getItem(storeKey)) return;
  const legacyState = localStorage.getItem(STORAGE_KEY);
  if (legacyState) localStorage.setItem(storeKey, legacyState);
}

function catalogProducts(meta = {}) {
  const overrides = meta.productOverrides || {};
  const deleted = new Set((meta.deletedItems || []).map(normalizeUpc));
  return PRODUCT_CATALOG.map(product => ({
    id: normalizeUpc(overrides[normalizeUpc(product.sku)]?.sku || product.sku),
    sourceSku: normalizeUpc(product.sku),
    name: cleanText(overrides[normalizeUpc(product.sku)]?.description || product.description),
    category: product.category,
    quantity: 0,
    originalQuantity: 0,
    backstock: 0,
    originalBackstock: 0,
    lastUpdated: null,
    notes: "",
    overrideCases: "",
    onSale: false,
    isCatalogProduct: true,
  })).filter(product => !deleted.has(product.sourceSku));
}

function mergeProductsWithCatalog(products, meta = state) {
  const overrides = meta.productOverrides || {};
  const deleted = new Set((meta.deletedItems || []).map(normalizeUpc));
  const byId = new Map();
  const bySource = new Map();
  for (const product of products || []) {
    const id = normalizeUpc(product.id || product.sku);
    if (!id) continue;
    const sourceSku = sourceSkuForProduct(product, meta);
    const normalized = {
      ...product,
      id,
      sourceSku,
      name: cleanText(product.name || product.description) || "Unnamed product",
    };
    byId.set(id, normalized);
    bySource.set(sourceSku, normalized);
  }

  const mergedCatalog = PRODUCT_CATALOG
    .filter(catalogProduct => !deleted.has(normalizeUpc(catalogProduct.sku)))
    .map(catalogProduct => {
    const sourceSku = normalizeUpc(catalogProduct.sku);
    const override = overrides[sourceSku] || {};
    const id = normalizeUpc(override.sku || catalogProduct.sku);
    const existing = bySource.get(sourceSku) || byId.get(id) || byId.get(sourceSku);
    return {
      id,
      sourceSku,
      name: cleanText(override.description || catalogProduct.description),
      category: catalogProduct.category,
      quantity: existing?.quantity ?? 0,
      originalQuantity: existing?.originalQuantity ?? existing?.quantity ?? 0,
      backstock: existing?.backstock ?? 0,
      originalBackstock: existing?.originalBackstock ?? existing?.backstock ?? 0,
      lastUpdated: existing?.lastUpdated || null,
      notes: existing?.notes || "",
      overrideCases: existing?.overrideCases ?? "",
      onSale: existing?.onSale || false,
      isCatalogProduct: true,
    };
  });

  const unknownProducts = [...byId.values()]
    .filter(product => {
      if (deleted.has(product.sourceSku) || deleted.has(product.id)) return false;
      if (skuToProductMap.has(product.sourceSku) || skuToProductMap.has(product.id)) return false;
      return true;
    })
    .map(product => ({
      id: product.id,
      sourceSku: product.sourceSku || product.id,
      name: product.name || "Unnamed product",
      category: "Unmatched Products",
      quantity: product.quantity ?? 0,
      originalQuantity: product.originalQuantity ?? product.quantity ?? 0,
      backstock: product.backstock ?? 0,
      originalBackstock: product.originalBackstock ?? product.backstock ?? 0,
      lastUpdated: product.lastUpdated || null,
      notes: product.notes || "",
      overrideCases: product.overrideCases ?? "",
      onSale: product.onSale || false,
      isCatalogProduct: false,
    }));

  return sortProducts([...mergedCatalog, ...unknownProducts]);
}

function sourceSkuForProduct(product, meta = state) {
  const id = normalizeUpc(product.sourceSku || product.id || product.sku);
  if (product.sourceSku) return id;
  const productId = normalizeUpc(product.id || product.sku);
  const overrides = meta.productOverrides || {};
  for (const [sourceSku, override] of Object.entries(overrides)) {
    if (normalizeUpc(override?.sku) === productId) return normalizeUpc(sourceSku);
  }
  return productId;
}

function loadState(storeNumber = currentStoreNumber || DEFAULT_STORE_NUMBER) {
  try {
    migrateLegacyStorageIfNeeded(storeNumber);
    const raw = localStorage.getItem(storageKeyForStore(storeNumber));
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const hydrated = {
      ...defaultState(),
      ...parsed,
      storeNumber,
      productOverrides: parsed.productOverrides || {},
      deletedItems: parsed.deletedItems || [],
      skuAliases: parsed.skuAliases || {},
      sales: {
        sessions: parsed.sales?.sessions || [],
        activeSessionId: parsed.sales?.activeSessionId || null,
      },
      processing: {
        matched: parsed.processing?.matched || [],
        unmatched: parsed.processing?.unmatched || [],
        deductions: parsed.processing?.deductions || [],
        recommendations: parsed.processing?.recommendations || [],
      },
      settings: {
        targetWeeks: Number(parsed.settings?.targetWeeks) || DEFAULT_TARGET_WEEKS,
        showSaleOnly: parsed.settings?.showSaleOnly === true,
      },
      lastSaved: parsed.lastSaved || null,
    };
    hydrated.inventory = {
      products: mergeProductsWithCatalog(parsed.inventory?.products || [], hydrated),
    };
    return hydrated;
  } catch {
    return defaultState();
  }
}

function saveLocalBackup() {
  state.lastSaved = new Date().toISOString();
  state.storeNumber = currentStoreNumber;
  localStorage.setItem(storageKeyForStore(currentStoreNumber), JSON.stringify(state));
  saveStoreRegistry();
  renderLastSaved();
}

function saveState({ showConfirmation = false } = {}) {
  saveLocalBackup();
  setSyncStatus("Local only");
  scheduleFirebaseSave();
  if (showConfirmation) showToast("Firebase save queued.");
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState(), 250);
}

function scheduleFirebaseSave() {
  clearTimeout(firebaseSaveTimer);
  if (isSwitchingStore) return;
  firebaseSaveTimer = setTimeout(() => syncCurrentStoreToFirebase({ silent: true }), FIREBASE_SAVE_DEBOUNCE_MS);
}

async function syncCurrentStoreToFirebase({ throwOnError = false, silent = false } = {}) {
  const storeNumber = selectedFirebaseStoreNumber();
  if (!storeNumber) {
    setSyncStatus("Local only");
    if (!silent) showToast("Select or add a store number before saving to Firebase.");
    return false;
  }
  if (!window.WineFirebaseSync?.saveStoreState) {
    setSyncStatus("Local only");
    return false;
  }
  try {
    setSyncStatus("Saving to Firebase…");
    await window.WineFirebaseSync.saveStoreState(storeNumber, serializeStateForFirestore());
    if (storeNumber === currentStoreNumber) setSyncStatus("Synced to Firebase");
    return true;
  } catch (error) {
    if (storeNumber === currentStoreNumber) {
      setSyncStatus("Firebase save failed");
      setStatus("Offline/local mode: changes are saved on this device and will sync when Firebase is available.");
    }
    console.error("Firebase save failed", error);
    if (throwOnError) throw error;
    return false;
  }
}

async function saveProjectNow() {
  clearTimeout(saveTimer);
  clearTimeout(firebaseSaveTimer);
  if (!selectedFirebaseStoreNumber()) {
    saveLocalBackup();
    setSyncStatus("Local only");
    showToast("Select or add a store number before saving to Firebase.");
    return;
  }
  saveLocalBackup();
  if (!window.WineFirebaseSync?.saveStoreState) {
    setSyncStatus("Local only");
    showToast("Firebase is not available. Project saved locally only.");
    return;
  }
  try {
    await syncCurrentStoreToFirebase({ throwOnError: true });
    showToast("Project saved to Firebase");
    setStatus(`Project saved to Firebase for Store ${currentStoreNumber}.`);
  } catch (error) {
    showToast("Firebase save failed. Project saved locally only.");
    setStatus("Firebase save failed. Project saved locally only.", true);
  }
}

function selectedFirebaseStoreNumber() {
  const storeNumber = cleanText(currentStoreNumber);
  return storeNumber && storeNumber !== DEFAULT_STORE_NUMBER ? storeNumber : "";
}

function serializeStateForFirestore() {
  const cleanState = JSON.parse(JSON.stringify(state));
  const products = cleanState.inventory?.products || [];
  return {
    ...cleanState,
    storeNumber: currentStoreNumber,
    inventoryCounts: Object.fromEntries(products.map(product => [product.id, product.quantity || 0])),
    frontStock: Object.fromEntries(products.map(product => [product.id, product.quantity || 0])),
    backStock: Object.fromEntries(products.map(product => [product.id, product.backstock || 0])),
    saleFlags: Object.fromEntries(products.map(product => [product.id, product.onSale === true])),
    salesData: cleanState.sales?.sessions || [],
    inventoryData: cleanState.inventory || { products: [] },
    importedSalesFileData: cleanState.sales || { sessions: [], activeSessionId: null },
    inventoryFileData: cleanState.inventory || { products: [] },
    productOverrides: cleanState.productOverrides || {},
    productEdits: cleanState.productOverrides || {},
    orderRecommendations: cleanState.processing?.recommendations || [],
    settings: cleanState.settings || {},
    clientLastSaved: cleanState.lastSaved || null,
  };
}

function hydrateStateFromRemote(remoteState, storeNumber) {
  const base = {
    ...defaultState(),
    ...remoteState,
    storeNumber,
    productOverrides: remoteState.productOverrides || remoteState.productEdits || {},
    deletedItems: remoteState.deletedItems || [],
    skuAliases: remoteState.skuAliases || {},
    sales: remoteState.sales || remoteState.importedSalesFileData || { sessions: [], activeSessionId: null },
    processing: remoteState.processing || {
      matched: [],
      unmatched: [],
      deductions: [],
      recommendations: remoteState.orderRecommendations || [],
    },
    settings: {
      ...defaultState().settings,
      ...(remoteState.settings || {}),
    },
    lastSaved: remoteState.clientLastSaved || remoteState.lastSaved || null,
  };
  base.inventory = {
    products: mergeProductsWithCatalog(
      remoteState.inventory?.products
        || remoteState.inventoryData?.products
        || remoteState.inventoryFileData?.products
        || [],
      base,
    ),
  };
  return base;
}

function bindEvents() {
  dom.storeSelect.addEventListener("change", event => switchStore(event.target.value));
  dom.addStoreButton.addEventListener("click", addStore);
  dom.uploadSalesButton.addEventListener("click", () => dom.salesInput.click());
  dom.uploadInventoryButton.addEventListener("click", () => dom.inventoryInput.click());
  dom.salesInput.addEventListener("change", event => handleSalesFile(event.target.files?.[0]));
  dom.inventoryInput.addEventListener("change", event => handleInventoryFile(event.target.files?.[0]));
  dom.saveProgressButton.addEventListener("click", saveProjectNow);
  dom.exportInventoryButton.addEventListener("click", exportInventoryCsv);
  dom.exportOrdersButton.addEventListener("click", exportOrdersCsv);
  dom.settingsButton.addEventListener("click", () => activateTab("settings"));
  dom.applyDeductionButton.addEventListener("click", applySalesDeduction);
  dom.clearSalesButton.addEventListener("click", clearSalesData);
  dom.clearInventoryButton.addEventListener("click", clearInventoryCounts);
  dom.clearSaleFlagsButton.addEventListener("click", clearAllSaleFlags);
  dom.restoreDeletedItemsButton.addEventListener("click", restoreDeletedInventoryItems);
  dom.clearAllButton.addEventListener("click", clearAllLocalData);
  dom.settingsExportInventoryButton.addEventListener("click", exportInventoryCsv);
  dom.settingsExportOrdersButton.addEventListener("click", exportOrdersCsv);
  dom.targetWeeksInput.addEventListener("change", () => {
    state.settings.targetWeeks = Math.max(0.5, Number(dom.targetWeeksInput.value) || DEFAULT_TARGET_WEEKS);
    recalculateRecommendations();
    saveState();
  });
  dom.saleOnlyToggle.addEventListener("change", () => {
    state.settings.showSaleOnly = dom.saleOnlyToggle.checked;
    render();
    saveState();
  });

  document.querySelectorAll(".tab-button").forEach(button => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });

  dom.inventoryTable.addEventListener("click", handleInventoryClick);
  dom.inventoryTable.addEventListener("change", handleInventoryChange);
  dom.orderingTable.addEventListener("change", handleOrderingChange);
  window.addEventListener("online", () => {
    setStatus("Back online. Syncing latest local changes to Firebase.");
    syncCurrentStoreToFirebase();
  });
  window.addEventListener("offline", () => {
    setSyncStatus("Local only");
    setStatus("Offline/local mode: changes are saved on this device and will sync when Firebase is available.");
  });
}

async function initializeFirebaseSync() {
  renderStoreSelector();
  if (!window.WineFirebaseSync?.ready) {
    setSyncStatus("Local only");
    return;
  }
  if (!selectedFirebaseStoreNumber()) {
    setSyncStatus("Local only");
    return;
  }
  try {
    await window.WineFirebaseSync.ready;
    await loadSelectedStoreFromFirebase();
  } catch (error) {
    setSyncStatus("Firebase save failed");
    setStatus("Offline/local mode: changes are saved on this device and will sync when Firebase is available.");
    console.warn("Firebase initialization failed", error);
  }
}

async function addStore() {
  const storeNumber = cleanText(prompt("Enter store number:"));
  if (!storeNumber) {
    showToast("Store number cannot be blank.");
    return;
  }
  if (!storeRegistry.stores.includes(storeNumber)) {
    storeRegistry.stores.push(storeNumber);
    storeRegistry.stores.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  currentStoreNumber = storeNumber;
  storeRegistry.currentStore = storeNumber;
  saveStoreRegistry();
  state = loadState(currentStoreNumber);
  editingProductId = null;
  render();
  try {
    setSyncStatus("Saving to Firebase…");
    await window.WineFirebaseSync?.createStoreIfMissing?.(storeNumber);
    await loadSelectedStoreFromFirebase({ createIfMissing: true });
    showToast(`Store ${storeNumber} selected.`);
  } catch (error) {
    setSyncStatus("Firebase save failed");
    setStatus("Offline/local mode: changes are saved on this device and will sync when Firebase is available.");
    console.warn("Add store Firebase setup failed", error);
  }
}

async function switchStore(storeNumber) {
  const nextStore = cleanText(storeNumber) || DEFAULT_STORE_NUMBER;
  if (nextStore === currentStoreNumber) return;
  isSwitchingStore = true;
  clearTimeout(saveTimer);
  clearTimeout(firebaseSaveTimer);
  currentStoreNumber = nextStore;
  storeRegistry.currentStore = nextStore;
  if (!storeRegistry.stores.includes(nextStore)) storeRegistry.stores.push(nextStore);
  saveStoreRegistry();
  state = loadState(currentStoreNumber);
  editingProductId = null;
  render();
  isSwitchingStore = false;
  await loadSelectedStoreFromFirebase();
}

async function loadSelectedStoreFromFirebase({ createIfMissing = false } = {}) {
  const storeNumber = selectedFirebaseStoreNumber();
  if (!storeNumber) {
    setSyncStatus("Local only");
    return;
  }
  if (!window.WineFirebaseSync?.getStoreState) {
    setSyncStatus("Local only");
    return;
  }
  try {
    const remoteState = await window.WineFirebaseSync.getStoreState(storeNumber);
    if (storeNumber !== currentStoreNumber) return;
    if (remoteState) {
      state = hydrateStateFromRemote(remoteState, storeNumber);
      localStorage.setItem(storageKeyForStore(storeNumber), JSON.stringify(state));
      render();
      setSyncStatus("Synced to Firebase");
      setStatus(`Store ${storeNumber} loaded from Firebase.`);
      return;
    }
    if (createIfMissing) await window.WineFirebaseSync.createStoreIfMissing(storeNumber);
    await syncCurrentStoreToFirebase();
  } catch (error) {
    if (storeNumber === currentStoreNumber) {
      setSyncStatus("Firebase save failed");
      setStatus("Offline/local mode: changes are saved on this device and will sync when Firebase is available.");
    }
    console.warn("Firebase store load failed", error);
  }
}

async function handleInventoryFile(file) {
  if (!file) return;
  try {
    setStatus(`Reading ${file.name}...`);
    const rows = await parseFileRows(file);
    const imported = parseInventoryRows(rows);
    state.inventory.products = mergeProductsWithCatalog([
      ...state.inventory.products,
      ...imported,
    ]);
    recalculateRecommendations();
    saveState();
    setStatus(`Loaded ${imported.length} inventory products from ${file.name}.`);
    showToast("Inventory file loaded.");
    activateTab("inventory");
  } catch (error) {
    setStatus(readableError(error), true);
    showToast(readableError(error));
  } finally {
    dom.inventoryInput.value = "";
  }
}

async function handleSalesFile(file) {
  if (!file) return;
  try {
    setStatus(`Reading ${file.name}...`);
    const rows = await parseFileRows(file);
    const parsedSales = parseSalesRows(rows);
    const session = {
      id: datasetId(file.name, parsedSales.rows.length, Date.now()),
      fileName: file.name,
      timestamp: new Date().toISOString(),
      rows: parsedSales.rows.length,
      salesRows: parsedSales.rows,
    };
    state.sales.activeSessionId = session.id;
    state.sales.sessions = [session, ...state.sales.sessions.filter(item => item.id !== session.id)].slice(0, 20);
    processSalesRows(parsedSales.rows);
    saveState();
    setStatus(`Loaded ${parsedSales.rows.length} sales rows from ${file.name}.`);
    showToast("Sales file loaded.");
    activateTab("ordering");
  } catch (error) {
    setStatus(readableError(error), true);
    showToast(readableError(error));
  } finally {
    dom.salesInput.value = "";
  }
}

function parseInventoryRows(rows) {
  if (!rows.length) throw new Error("Inventory file is empty.");
  const header = rows[0].map(cell => String(cell || "").trim());
  const upcIndex = findColumn(header, SKU_HEADER_ALIASES);
  const descriptionIndex = findColumn(header, ["description", "product", "product name", "name", "item description", "item"]);
  const quantityIndex = findColumn(header, ["quantity", "front", "front units", "front of house", "front - units"]);
  const backstockIndex = findColumn(header, ["backstock", "backstock cases", "back of house", "back - cases"]);

  if (upcIndex < 0) throw new Error(`Could not find JDE/UPC column. Detected columns: ${detectedHeaderSummary(header)}`);
  if (descriptionIndex < 0) throw new Error(`Could not find Description column. Detected columns: ${detectedHeaderSummary(header)}`);

  const products = [];
  const seen = new Set();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const id = normalizeUpc(row[upcIndex]);
    const name = cleanText(row[descriptionIndex]);
    if (!id && !name) continue;
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    products.push({
      id,
      name: name || "Unnamed product",
      quantity: quantityIndex >= 0 ? parseWholeNumber(row[quantityIndex]) : undefined,
      originalQuantity: quantityIndex >= 0 ? parseWholeNumber(row[quantityIndex]) : undefined,
      backstock: backstockIndex >= 0 ? parseWholeNumber(row[backstockIndex]) : undefined,
      originalBackstock: backstockIndex >= 0 ? parseWholeNumber(row[backstockIndex]) : undefined,
      lastUpdated: new Date().toISOString(),
      notes: "",
      overrideCases: "",
      onSale: false,
    });
  }
  if (!products.length) throw new Error("Inventory file did not contain any usable product rows.");
  return products;
}

function parseSalesRows(rows) {
  if (!rows.length) throw new Error("Sales file is empty.");
  const header = rows[0].map(cell => String(cell || "").trim());
  const upcIndex = findColumn(header, SKU_HEADER_ALIASES);
  const descriptionIndex = columnOrFallback(header, ["description", "product", "product name", "name", "item description", "item"], 2);
  const packIndex = columnOrFallback(header, ["pack", "size", "package", "sub brand", "description", "item"], 3);
  const unitsIndex = columnOrFallback(header, ["units sold", "units", "quantity sold", "sold"], 4);
  if (upcIndex < 0) throw new Error(`Could not find JDE/UPC column. Detected columns: ${detectedHeaderSummary(header)}`);
  if (unitsIndex < 0) throw new Error(`Could not find Units column. Detected columns: ${detectedHeaderSummary(header)}`);

  const salesRows = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rawUpc = cleanText(row[upcIndex]);
    const id = normalizeUpc(rawUpc);
    const pack = cleanText(row[packIndex]);
    let description = cleanText(row[descriptionIndex]);
    if (looksLikeCode(description) && pack && !looksLikeCode(pack)) {
      description = pack;
    }
    const unitsSold = parseNumber(row[unitsIndex]);
    if (!id && !description && unitsSold == null) continue;
    if (description.toLowerCase() === "total" || description.toLowerCase() === "summary") continue;
    salesRows.push({
      rowNumber: rowIndex + 1,
      id,
      description: description || "Unnamed product",
      pack,
      unitsSold,
      unitsPerCase: parseCaseSize(`${pack} ${description}`),
    });
  }
  if (!salesRows.length) throw new Error("Sales file did not contain any usable sales rows.");
  return { rows: salesRows };
}

function processSalesRows(salesRows) {
  const productById = new Map(
    state.inventory.products
      .filter(product => productCategoryInfo(product))
      .flatMap(product => {
        const keys = new Set([product.id, product.sourceSku, resolveSku(product.sourceSku)]);
        return [...keys].filter(Boolean).map(key => [normalizeUpc(key), product]);
      }),
  );
  const salesById = new Map();
  const unmatched = [];

  for (const row of salesRows) {
    const resolvedId = resolveSku(row.id);
    const product = productById.get(resolvedId);
    if (!resolvedId || !product) {
      unmatched.push({ ...row, status: "Unmatched", reason: "No inventory JDE/UPC match" });
      continue;
    }
    const current = salesById.get(product.id) || {
      id: product.id,
      unitsSold: 0,
      unitsPerCase: row.unitsPerCase || parseCaseSize(`${product.name}`),
      description: product.name || row.description,
      pack: row.pack,
      rows: [],
    };
    current.unitsSold += Number(row.unitsSold || 0);
    current.unitsPerCase = current.unitsPerCase || row.unitsPerCase || parseCaseSize(`${product.name} ${row.pack}`);
    current.rows.push(row.rowNumber);
    salesById.set(product.id, current);
  }

  state.processing.matched = [...salesById.values()];
  state.processing.unmatched = unmatched;
  recalculateRecommendations();
}

function recalculateRecommendations() {
  const salesById = new Map(state.processing.matched.map(item => [item.id, item]));
  state.processing.recommendations = sortProducts(state.inventory.products)
    .filter(product => productCategoryInfo(product))
    .map(product => {
      const sales = salesById.get(product.id);
      const unitsSold = sales?.unitsSold ?? 0;
      const unitsPerCase = sales?.unitsPerCase || parseCaseSize(`${product.name}`) || 12;
      const totalUnitsOnHand = (Number(product.backstock || 0) * unitsPerCase) + Number(product.quantity || 0);
      const weeksOfProduct = unitsSold > 0 ? totalUnitsOnHand / unitsSold : null;
      const netUnitsNeeded = Math.max(0, unitsSold - totalUnitsOnHand);
      const calculatedCases = unitsSold > 0 ? Math.ceil(netUnitsNeeded / unitsPerCase) : 0;
      const overrideCases = product.overrideCases === "" || product.overrideCases == null
        ? null
        : Math.max(0, Number(product.overrideCases) || 0);
      const orderCases = overrideCases ?? calculatedCases;
      const unitOrder = orderCases * unitsPerCase;
      return {
        id: product.id,
        name: product.name,
        unitsSold,
        unitsPerCase,
        front: Number(product.quantity || 0),
        backstock: Number(product.backstock || 0),
        totalUnitsOnHand,
        weeksOfProduct,
        orderCases,
        unitOrder,
        status: unitsSold <= 0 || (weeksOfProduct != null && weeksOfProduct >= 2)
          ? "Do Not Order"
          : "Order Needed",
        notes: product.notes || "",
        overrideCases: product.overrideCases ?? "",
      };
    });
  render();
}

async function parseFileRows(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    return parseCsv(await file.text());
  }
  if (!name.endsWith(".xlsx")) {
    throw new Error("Invalid format. Upload an XLSX or CSV file.");
  }
  if (!window.XLSX) {
    throw new Error(
      "XLSX support is not loaded. The app needs the SheetJS xlsx.full.min.js file to read Excel files. Make sure xlsx.full.min.js is included in the project and loaded before app.js.",
    );
  }
  const bytes = await file.arrayBuffer();
  const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Workbook is missing a worksheet.");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error("The first worksheet could not be loaded.");
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows.filter(items => items.some(value => cleanText(value)));
}

function render() {
  renderStoreSelector();
  renderSyncStatus();
  renderLastSaved();
  dom.targetWeeksInput.value = state.settings.targetWeeks;
  dom.saleOnlyToggle.checked = state.settings.showSaleOnly === true;
  renderInventorySummary();
  renderOrderingSummary();
  renderInventoryTable();
  renderOrderingTable();
  renderUnmatched();
}

function renderStoreSelector() {
  dom.storeSelect.innerHTML = storeRegistry.stores
    .map(storeNumber => `<option value="${escapeHtml(storeNumber)}" ${storeNumber === currentStoreNumber ? "selected" : ""}>${escapeHtml(storeNumber)}</option>`)
    .join("");
  dom.currentStoreText.textContent = `Current store: ${currentStoreNumber}`;
}

function renderSyncStatus() {
  dom.syncStatusText.textContent = syncStatus;
  dom.syncStatusText.className = `sync-status ${syncStatusClass(syncStatus)}`;
}

function renderLastSaved() {
  dom.lastSavedText.textContent = state.lastSaved ? formatDateTime(state.lastSaved) : "Never";
}

function renderInventorySummary() {
  const visible = state.inventory.products.filter(product => productCategoryInfo(product));
  const unknown = state.inventory.products.filter(product => !productCategoryInfo(product));
  const totalFront = visible.reduce((sum, product) => sum + Number(product.quantity || 0), 0);
  const totalBack = visible.reduce((sum, product) => sum + Number(product.backstock || 0), 0);
  dom.inventorySummary.innerHTML = [
    metric("Products", visible.length),
    metric("Front Units", totalFront),
    metric("Backstock Cases", totalBack),
    metric("Unmatched Products", unknown.length),
  ].join("");
}

function renderOrderingSummary() {
  const recommendations = state.processing.recommendations || [];
  const orderNeeded = recommendations.filter(item => item.status === "Order Needed").length;
  const totalUnitsSold = recommendations.reduce((sum, item) => sum + Number(item.unitsSold || 0), 0);
  const active = state.sales.sessions.find(session => session.id === state.sales.activeSessionId);
  dom.orderingSummary.innerHTML = [
    metric("Sales Rows", active?.rows || 0),
    metric("Matched", state.processing.matched.length),
    metric("Unmatched", state.processing.unmatched.length),
    metric("Units Sold", formatNumber(totalUnitsSold)),
    metric("Order Needed", orderNeeded),
  ].join("");
}

function renderInventoryTable() {
  const sortedProducts = sortProducts(state.inventory.products);
  const filteredProducts = state.settings.showSaleOnly
    ? sortedProducts.filter(product => product.onSale)
    : sortedProducts;
  const visibleProducts = filteredProducts.filter(product => productCategoryInfo(product));
  const unknownProducts = filteredProducts.filter(product => !productCategoryInfo(product));

  let html = `<table><thead><tr>
    <th>JDE/UPC</th><th>Description</th><th class="center-cell">Front</th>
    <th class="center-cell">Backstock</th><th>Notes</th><th class="center-cell">Sale</th><th class="center-cell">Actions</th>
  </tr></thead><tbody>`;
  for (const section of CATEGORY_CONFIG) {
    const products = visibleProducts.filter(product => productCategoryInfo(product)?.name === section.name);
    if (!products.length) continue;
    html += `<tr class="category-row"><td colspan="7">${escapeHtml(section.name)}</td></tr>`;
    for (const product of products) {
      html += inventoryRowHtml(product);
    }
  }
  if (unknownProducts.length) {
    html += `<tr class="category-row"><td colspan="7">Unmatched Products</td></tr>`;
    for (const product of unknownProducts) {
      html += inventoryRowHtml(product);
    }
  }
  html += "</tbody></table>";
  dom.inventoryTable.innerHTML = html;
}

function inventoryRowHtml(product) {
  const isEditing = editingProductId === product.id;
  const rowTitle = product.onSale ? "This item is currently marked as on sale." : "";
  if (isEditing) {
    return `<tr class="${product.onSale ? "sale-item-row" : ""}" data-id="${escapeHtml(product.id)}" title="${rowTitle}">
      <td><input class="edit-input sku-edit-input" data-edit-field="sku" data-id="${escapeHtml(product.id)}" value="${escapeHtml(product.id)}" /></td>
      <td><input class="edit-input description-edit-input" data-edit-field="description" data-id="${escapeHtml(product.id)}" value="${escapeHtml(product.name)}" /></td>
      <td class="number-cell">${quantityControl(product.id, "quantity", product.quantity || 0)}</td>
      <td class="number-cell">${quantityControl(product.id, "backstock", product.backstock || 0)}</td>
      <td><input class="notes-input" data-field="notes" data-id="${escapeHtml(product.id)}" value="${escapeHtml(product.notes || "")}" /></td>
      <td class="center-cell"><input type="checkbox" data-field="onSale" data-id="${escapeHtml(product.id)}" ${product.onSale ? "checked" : ""} title="This item is currently marked as on sale." /></td>
      <td class="center-cell row-actions">
        <button class="action-button save-action" data-action="saveEdit" data-id="${escapeHtml(product.id)}" title="Save product edits">Save</button>
        <button class="action-button" data-action="cancelEdit" data-id="${escapeHtml(product.id)}" title="Cancel product edits">Cancel</button>
      </td>
    </tr>`;
  }

  return `<tr class="${product.onSale ? "sale-item-row" : ""}" data-id="${escapeHtml(product.id)}" title="${rowTitle}">
    <td>${escapeHtml(product.id)}</td>
    <td class="desc-cell product-name-cell" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}${saleBadge(product)}</td>
    <td class="number-cell">${quantityControl(product.id, "quantity", product.quantity || 0)}</td>
    <td class="number-cell">${quantityControl(product.id, "backstock", product.backstock || 0)}</td>
    <td><input class="notes-input" data-field="notes" data-id="${escapeHtml(product.id)}" value="${escapeHtml(product.notes || "")}" /></td>
    <td class="center-cell"><input type="checkbox" data-field="onSale" data-id="${escapeHtml(product.id)}" ${product.onSale ? "checked" : ""} title="This item is currently marked as on sale." /></td>
    <td class="center-cell row-actions">
      <button class="icon-action" data-action="editProduct" data-id="${escapeHtml(product.id)}" title="Edit SKU and description" aria-label="Edit ${escapeHtml(product.name)}">&#9998;</button>
      <button class="icon-action danger-icon" data-action="deleteProduct" data-id="${escapeHtml(product.id)}" title="Delete inventory item" aria-label="Delete ${escapeHtml(product.name)}">&#128465;</button>
    </td>
  </tr>`;
}

function renderOrderingTable() {
  const recommendations = state.settings.showSaleOnly
    ? (state.processing.recommendations || []).filter(item => getProduct(item.id)?.onSale)
    : state.processing.recommendations || [];
  if (!recommendations.length) {
    dom.orderingTable.innerHTML = `<div class="empty-state">Upload a sales file to calculate order recommendations from the built-in catalog.</div>`;
    dom.applyDeductionButton.disabled = true;
    dom.deductionStatus.textContent = "";
    return;
  }

  const activeId = state.sales.activeSessionId;
  const alreadyDeducted = state.processing.deductions.some(item => item.sessionId === activeId);
  dom.applyDeductionButton.disabled = !activeId || alreadyDeducted;
  dom.deductionStatus.textContent = alreadyDeducted
    ? "Sales deduction already applied for this sales file."
    : "Deducts Units Sold from Front only.";

  let html = `<table><thead><tr>
    <th>JDE/UPC</th><th>Description</th><th class="center-cell">Units Sold</th>
    <th class="center-cell">Total Units On Hand</th><th class="center-cell">Weeks</th>
    <th class="center-cell">Order Cases</th><th class="center-cell">Unit Order</th>
    <th class="center-cell">Override</th><th>Status</th><th>Notes</th>
  </tr></thead><tbody>`;
  for (const section of CATEGORY_CONFIG) {
    const rows = recommendations.filter(item => productCategoryInfo(getProduct(item.id) || item)?.name === section.name);
    if (!rows.length) continue;
    html += `<tr class="category-row"><td colspan="10">${escapeHtml(section.name)}</td></tr>`;
    for (const item of rows) {
      const statusClass = item.status === "Order Needed" ? "status-order" : "status-ok";
      const onSale = getProduct(item.id)?.onSale === true;
      html += `<tr class="${onSale ? "sale-item-row" : ""}" data-id="${escapeHtml(item.id)}" title="${onSale ? "This item is currently marked as on sale." : ""}">
        <td>${escapeHtml(item.id)}</td>
        <td class="desc-cell product-name-cell" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}${onSale ? saleBadge({ onSale: true }) : ""}</td>
        <td class="number-cell">${formatNumber(item.unitsSold)}</td>
        <td class="number-cell">${formatNumber(item.totalUnitsOnHand)}</td>
        <td class="number-cell">${item.weeksOfProduct == null ? "N/A" : item.weeksOfProduct.toFixed(1)}</td>
        <td class="number-cell">${item.orderCases}</td>
        <td class="number-cell">${formatNumber(item.unitOrder)}</td>
        <td class="number-cell"><input class="small-number" type="number" min="0" data-field="overrideCases" data-id="${escapeHtml(item.id)}" value="${escapeHtml(item.overrideCases ?? "")}" /></td>
        <td><span class="status-pill ${statusClass}">${escapeHtml(item.status)}</span></td>
        <td class="desc-cell" title="${escapeHtml(item.notes || "")}">${escapeHtml(item.notes || "")}</td>
      </tr>`;
    }
  }
  html += "</tbody></table>";
  dom.orderingTable.innerHTML = html;
}

function renderUnmatched() {
  const unmatched = state.settings.showSaleOnly ? [] : state.processing.unmatched || [];
  if (!unmatched.length) {
    dom.unmatchedList.innerHTML = `<div class="small-muted">No unmatched rows.</div>`;
    return;
  }
  dom.unmatchedList.innerHTML = unmatched.map(row => `
    <div class="unmatched-item">
      <strong>Row ${row.rowNumber}</strong> |
      UPC: ${escapeHtml(row.id || "-")} |
      ${escapeHtml(row.description || "Unnamed product")} |
      ${escapeHtml(row.reason || "Unmatched")}
    </div>
  `).join("");
}

function handleInventoryClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const product = getProduct(button.dataset.id);
  if (!product) return;
  if (button.dataset.action === "editProduct") {
    editingProductId = product.id;
    renderInventoryTable();
    return;
  }
  if (button.dataset.action === "cancelEdit") {
    editingProductId = null;
    renderInventoryTable();
    return;
  }
  if (button.dataset.action === "saveEdit") {
    saveProductEdit(product);
    return;
  }
  if (button.dataset.action === "deleteProduct") {
    deleteInventoryItem(product);
    return;
  }
  const field = button.dataset.field;
  const delta = Number(button.dataset.delta);
  product[field] = Math.max(0, Number(product[field] || 0) + delta);
  product.lastUpdated = new Date().toISOString();
  recalculateRecommendations();
  scheduleSave();
}

function handleInventoryChange(event) {
  const input = event.target;
  const id = input.dataset.id;
  const field = input.dataset.field;
  if (!id || !field) return;
  const product = getProduct(id);
  if (!product) return;
  if (field === "quantity" || field === "backstock") {
    product[field] = Math.max(0, parseWholeNumber(input.value));
  } else if (field === "onSale") {
    product.onSale = input.checked;
  } else {
    product[field] = input.value;
  }
  product.lastUpdated = new Date().toISOString();
  recalculateRecommendations();
  scheduleSave();
}

function saveProductEdit(product) {
  const sourceSku = product.sourceSku || product.id;
  const skuInput = dom.inventoryTable.querySelector(`input[data-edit-field="sku"][data-id="${cssEscape(product.id)}"]`);
  const descriptionInput = dom.inventoryTable.querySelector(`input[data-edit-field="description"][data-id="${cssEscape(product.id)}"]`);
  const newSku = normalizeUpc(skuInput?.value || "");
  const newDescription = cleanText(descriptionInput?.value || "");
  if (!newSku) {
    showToast("Enter a SKU/JDE/UPC before saving.");
    return;
  }
  if (!newDescription) {
    showToast("Enter a product description before saving.");
    return;
  }
  if (skuExistsOnAnotherProduct(newSku, sourceSku)) {
    showToast("That SKU already exists. Please use a different SKU.");
    return;
  }

  const oldSku = product.id;
  state.productOverrides[sourceSku] = {
    sku: newSku,
    description: newDescription,
  };
  if (newSku !== sourceSku) {
    state.skuAliases[sourceSku] = newSku;
    state.skuAliases[oldSku] = newSku;
  } else {
    delete state.skuAliases[sourceSku];
    delete state.skuAliases[oldSku];
  }
  moveProcessingSku(oldSku, newSku);
  editingProductId = null;
  state.inventory.products = mergeProductsWithCatalog(state.inventory.products, state);
  refreshProcessingFromActiveSales();
  saveState();
  setStatus(`Updated ${newSku}.`);
  showToast("Product saved.");
}

function deleteInventoryItem(product) {
  if (!confirm("Are you sure you want to delete this inventory item? This cannot be undone.")) return;
  const sourceSku = product.sourceSku || product.id;
  state.deletedItems = [...new Set([...(state.deletedItems || []), sourceSku].map(normalizeUpc))];
  delete state.productOverrides[sourceSku];
  const deleteKeys = [sourceSku, product.id].map(normalizeUpc);
  for (const [aliasFrom, aliasTo] of Object.entries(state.skuAliases || {})) {
    const from = normalizeUpc(aliasFrom);
    const to = normalizeUpc(aliasTo);
    if (deleteKeys.includes(from) || deleteKeys.includes(to)) {
      delete state.skuAliases[aliasFrom];
    }
  }
  state.inventory.products = state.inventory.products.filter(item => {
    const itemSource = item.sourceSku || item.id;
    return item.id !== product.id && itemSource !== sourceSku;
  });
  state.processing.matched = (state.processing.matched || []).filter(item => item.id !== product.id && item.id !== sourceSku);
  state.processing.recommendations = (state.processing.recommendations || []).filter(item => item.id !== product.id && item.id !== sourceSku);
  editingProductId = null;
  state.inventory.products = mergeProductsWithCatalog(state.inventory.products, state);
  refreshProcessingFromActiveSales();
  saveState();
  setStatus(`Deleted ${product.id}.`);
  showToast("Inventory item deleted.");
}

function restoreDeletedInventoryItems() {
  if (!state.deletedItems?.length) {
    showToast("There are no deleted built-in items to restore.");
    return;
  }
  if (!confirm("Restore deleted built-in inventory items? Saved counts for current visible products will be kept.")) return;
  state.deletedItems = [];
  state.inventory.products = mergeProductsWithCatalog(state.inventory.products, state);
  refreshProcessingFromActiveSales();
  saveState();
  setStatus("Deleted inventory items restored.");
  showToast("Deleted inventory items restored.");
}

function skuExistsOnAnotherProduct(sku, currentSourceSku) {
  const normalizedSku = normalizeUpc(sku);
  const normalizedSource = normalizeUpc(currentSourceSku);
  const catalogProduct = skuToProductMap.get(normalizedSku);
  if (catalogProduct && normalizeUpc(catalogProduct.sku) !== normalizedSource) return true;
  return state.inventory.products.some(product => {
    const productSource = normalizeUpc(product.sourceSku || product.id);
    if (productSource === normalizedSource) return false;
    return normalizeUpc(product.id) === normalizedSku || productSource === normalizedSku;
  });
}

function moveProcessingSku(oldSku, newSku) {
  const oldNormalized = normalizeUpc(oldSku);
  const newNormalized = normalizeUpc(newSku);
  for (const collectionName of ["matched", "unmatched", "recommendations"]) {
    state.processing[collectionName] = (state.processing[collectionName] || []).map(item => {
      if (normalizeUpc(item.id) !== oldNormalized) return item;
      return { ...item, id: newNormalized };
    });
  }
}

function refreshProcessingFromActiveSales() {
  const active = state.sales.sessions.find(session => session.id === state.sales.activeSessionId);
  if (active?.salesRows?.length) {
    processSalesRows(active.salesRows);
    return;
  }
  recalculateRecommendations();
}

function handleOrderingChange(event) {
  const input = event.target;
  if (input.dataset.field !== "overrideCases") return;
  const product = getProduct(input.dataset.id);
  if (!product) return;
  product.overrideCases = input.value === "" ? "" : Math.max(0, parseWholeNumber(input.value));
  product.lastUpdated = new Date().toISOString();
  recalculateRecommendations();
  scheduleSave();
}

function applySalesDeduction() {
  const activeId = state.sales.activeSessionId;
  if (!activeId) {
    showToast("Load a sales file before applying deduction.");
    return;
  }
  if (state.processing.deductions.some(item => item.sessionId === activeId)) {
    showToast("Sales deduction already applied for this file.");
    return;
  }
  const matched = state.processing.matched || [];
  if (!matched.length) {
    showToast("No matched sales rows to deduct.");
    return;
  }
  const confirmed = confirm("Deduct Units Sold from Front inventory only? Backstock will not be changed.");
  if (!confirmed) return;

  let deductedUnits = 0;
  let shortageRows = 0;
  for (const row of matched) {
    const product = getProduct(row.id);
    if (!product) continue;
    const before = Number(product.quantity || 0);
    const units = Math.max(0, Math.ceil(row.unitsSold || 0));
    const deducted = Math.min(before, units);
    product.quantity = Math.max(0, before - units);
    product.lastUpdated = new Date().toISOString();
    deductedUnits += deducted;
    if (units > before) shortageRows += 1;
  }
  state.processing.deductions.unshift({
    sessionId: activeId,
    appliedAt: new Date().toISOString(),
    rows: matched.length,
    deductedUnits,
    shortageRows,
  });
  recalculateRecommendations();
  saveState();
  setStatus(`Deducted ${deductedUnits} units from Front. Backstock unchanged.`);
  showToast("Sales deduction applied.");
}

function clearSalesData() {
  if (!confirm("Clear all prior sales data? Inventory counts will not be changed.")) return;
  state.sales = { sessions: [], activeSessionId: null };
  state.processing = { matched: [], unmatched: [], deductions: [], recommendations: [] };
  saveState();
  setStatus("Sales data cleared. Inventory was not changed.");
  showToast("Sales data cleared.");
}

function clearInventoryCounts() {
  if (!confirm("Clear all inventory count data? Product names and order lineup will remain.")) return;
  for (const product of state.inventory.products) {
    product.quantity = 0;
    product.backstock = 0;
    product.lastUpdated = new Date().toISOString();
  }
  recalculateRecommendations();
  saveState();
  setStatus("Inventory counts cleared.");
  showToast("Inventory count data cleared.");
}

function clearAllSaleFlags() {
  if (!confirm("Clear all On Sale flags? Inventory counts and sales data will not be changed.")) return;
  for (const product of state.inventory.products) {
    product.onSale = false;
    product.lastUpdated = new Date().toISOString();
  }
  state.settings.showSaleOnly = false;
  recalculateRecommendations();
  saveState();
  setStatus("All sale flags cleared.");
  showToast("Sale flags cleared.");
}

function clearAllLocalData() {
  if (!confirm(`Clear all saved data for Store ${currentStoreNumber}? This will also sync the cleared state to Firebase when available.`)) return;
  localStorage.removeItem(storageKeyForStore(currentStoreNumber));
  state = defaultState();
  render();
  saveState();
  setStatus(`Store ${currentStoreNumber} data cleared.`);
  showToast("Store data cleared.");
}

function exportInventoryCsv() {
  const rows = [["Product Name", "SKU / ID", "Quantity", "Backstock Cases", "Last Updated", "Notes"]];
  for (const product of sortProducts(state.inventory.products)) {
    rows.push([
      product.name,
      product.id,
      product.quantity || 0,
      product.backstock || 0,
      product.lastUpdated || "",
      product.notes || "",
    ]);
  }
  downloadCsv(`inventory_export_${fileTimestamp()}.csv`, rows);
}

function exportOrdersCsv() {
  const rows = [["JDE/UPC", "Description", "Units Sold", "Units Per Case", "Total Units On Hand", "Weeks of Product", "Order Cases", "Unit Order", "Status", "Notes"]];
  for (const item of state.processing.recommendations || []) {
    rows.push([
      item.id,
      item.name,
      item.unitsSold,
      item.unitsPerCase,
      item.totalUnitsOnHand,
      item.weeksOfProduct == null ? "N/A" : item.weeksOfProduct.toFixed(1),
      item.orderCases,
      item.unitOrder,
      item.status,
      item.notes || "",
    ]);
  }
  downloadCsv(`order_recommendations_${fileTimestamp()}.csv`, rows);
}

function downloadCsv(fileName, rows) {
  const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`Exported ${fileName}.`);
}

function quantityControl(id, field, value) {
  return `<span class="quantity-control">
    <button data-action="adjust" data-field="${field}" data-id="${escapeHtml(id)}" data-delta="-1">-</button>
    <input type="number" min="0" data-field="${field}" data-id="${escapeHtml(id)}" value="${Number(value || 0)}" />
    <button data-action="adjust" data-field="${field}" data-id="${escapeHtml(id)}" data-delta="1">+</button>
  </span>`;
}

function saleBadge(item) {
  return item?.onSale ? ` <span class="sale-badge">ON SALE</span>` : "";
}

function sortProducts(products) {
  return [...products].sort((a, b) => {
    const aOrder = productCategoryInfo(a);
    const bOrder = productCategoryInfo(b);
    const aCategory = aOrder?.categoryIndex ?? 99;
    const bCategory = bOrder?.categoryIndex ?? 99;
    if (aCategory !== bCategory) return aCategory - bCategory;
    const aItem = aOrder?.itemIndex ?? 9999;
    const bItem = bOrder?.itemIndex ?? 9999;
    if (aItem !== bItem) return aItem - bItem;
    return (a.name || "").localeCompare(b.name || "");
  });
}

function getProduct(id) {
  const normalized = normalizeUpc(id);
  return state.inventory.products.find(product => normalizeUpc(product.id) === normalized);
}

function productCategoryInfo(productOrId) {
  if (!productOrId) return null;
  const directId = typeof productOrId === "object"
    ? normalizeUpc(productOrId.id)
    : normalizeUpc(productOrId);
  const sourceSku = typeof productOrId === "object"
    ? normalizeUpc(productOrId.sourceSku || productOrId.id)
    : directId;
  const fixed = fixedProductOrderIndex.get(sourceSku) || fixedProductOrderIndex.get(directId);
  if (fixed) {
    return {
      name: fixed.category,
      categoryIndex: fixed.categoryIndex,
      itemIndex: fixed.itemIndex,
      globalIndex: fixed.globalIndex,
    };
  }
  return categoryByUpc.get(sourceSku) || categoryByUpc.get(directId) || null;
}

function resolveSku(value) {
  const sku = normalizeUpc(value);
  if (!sku) return "";
  const alias = normalizeUpc(state.skuAliases?.[sku]);
  if (alias) return alias;
  const override = state.productOverrides?.[sku];
  if (override?.sku) return normalizeUpc(override.sku);
  return sku;
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

function findColumn(header, aliases) {
  const normalizedAliases = aliases.flatMap(headerVariants);
  return header.findIndex(value => {
    const variants = headerVariants(value);
    return variants.some(variant => normalizedAliases.includes(variant));
  });
}

function columnOrFallback(header, aliases, fallback) {
  const found = findColumn(header, aliases);
  return found >= 0 ? found : fallback;
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/#/g, "")
    .replace(/[\/\-_]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactHeader(value) {
  return normalizeHeader(value).replace(/\s+/g, "");
}

function headerVariants(value) {
  return [normalizeHeader(value), compactHeader(value)].filter(Boolean);
}

function detectedHeaderSummary(header) {
  const detected = header.map(cleanText).filter(Boolean);
  if (!detected.length) return "none";
  const preview = detected.slice(0, 12).join(", ");
  return detected.length > 12 ? `${preview}...` : preview;
}

function normalizeUpc(value) {
  let text = cleanText(value);
  if (/^\d+\.0$/.test(text)) text = text.slice(0, -2);
  return text.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseWholeNumber(value) {
  const parsed = Math.floor(Number(String(value ?? "").replace(/,/g, "")));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseNumber(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCaseSize(value) {
  const text = cleanText(value);
  const packMatch = text.match(/(?:^|[^\d.])\d+(?:\.\d+)?\s*\/\s*(\d+(?:\.\d+)?)/);
  if (packMatch) return Number(packMatch[1]);
  const rules = [
    [/\b750\s*m\s*l\b|\b750ml\b/i, 12],
    [/\b1\s*l\b|\b1l\b/i, 12],
    [/\b355\s*m\s*l\b|\b355ml\b/i, 24],
    [/\b200\s*m\s*l\b|\b200ml\b/i, 24],
    [/\b1\.5\s*l\b|\b1\.5l\b/i, 6],
    [/\b4\s*l\b|\b4l\b/i, 4],
  ];
  for (const [pattern, size] of rules) {
    if (pattern.test(text)) return size;
  }
  return null;
}

function looksLikeCode(value) {
  const text = cleanText(value);
  return /^[0-9]{5,}$/.test(text) || /^[A-Z0-9]{5,}$/.test(text);
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function setStatus(message, isError = false) {
  dom.statusBanner.textContent = message;
  dom.statusBanner.classList.toggle("error", isError);
}

function setSyncStatus(message) {
  syncStatus = message;
  renderSyncStatus();
}

function syncStatusClass(message) {
  if (message === "Synced to Firebase") return "synced";
  if (message === "Saving to Firebase…") return "syncing";
  if (message === "Firebase save failed") return "error";
  return "local";
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("show");
  setTimeout(() => dom.toast.classList.remove("show"), 2400);
}

function activateTab(name) {
  document.querySelectorAll(".tab-button").forEach(button => {
    button.classList.toggle("active", button.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === `${name}Tab`);
  });
}

function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatDateTime(value) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fileTimestamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}${min}`;
}

function datasetId(fileName, rowCount, timestamp) {
  return `${fileName.toLowerCase()}|${rowCount}|${timestamp}`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function readableError(error) {
  return error?.message || "The file could not be loaded. Check the format and try again.";
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {
      // Offline caching is a convenience only; the app still works without it.
    });
  });
}



