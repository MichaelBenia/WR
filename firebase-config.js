const firebaseConfig = {
  apiKey: "AIzaSyAc_hmpYESlttYrdB73tiC9bhHFkY5kpjw",
  authDomain: "wrorder-c8274.firebaseapp.com",
  projectId: "wrorder-c8274",
  storageBucket: "wrorder-c8274.firebasestorage.app",
  messagingSenderId: "312710229623",
  appId: "1:312710229623:web:e6ad9924a0c8f6ff7ba072",
  measurementId: "G-2TD4K0F91V",
};

// Firestore is used from the browser so GitHub Pages can stay fully static.
// Testing-only Firestore rules are documented in README.md. Do not share a
// public unauthenticated deployment without adding Firebase Authentication.
window.WineFirebaseSync = (() => {
  let db = null;
  let firestoreApi = null;

  const ready = (async () => {
    const appModule = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js");
    const firestoreModule = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");

    const app = appModule.initializeApp(firebaseConfig);
    firestoreApi = {
      doc: firestoreModule.doc,
      getDoc: firestoreModule.getDoc,
      setDoc: firestoreModule.setDoc,
      updateDoc: firestoreModule.updateDoc,
      serverTimestamp: firestoreModule.serverTimestamp,
    };
    db = firestoreModule.getFirestore(app);
    return true;
  })();

  function storeDoc(storeNumber) {
    return firestoreApi.doc(db, "stores", String(storeNumber));
  }

  function appStateDoc(storeNumber) {
    return firestoreApi.doc(db, "stores", String(storeNumber), "data", "appState");
  }

  async function createStoreIfMissing(storeNumber) {
    await ready;
    const ref = storeDoc(storeNumber);
    const snapshot = await firestoreApi.getDoc(ref);
    if (!snapshot.exists()) {
      await firestoreApi.setDoc(ref, {
        storeNumber: String(storeNumber),
        createdAt: firestoreApi.serverTimestamp(),
        lastUpdated: firestoreApi.serverTimestamp(),
      });
    }
  }

  async function getStoreState(storeNumber) {
    await ready;
    const snapshot = await firestoreApi.getDoc(appStateDoc(storeNumber));
    return snapshot.exists() ? snapshot.data() : null;
  }

  async function saveStoreState(storeNumber, appState) {
    await ready;
    const cleanState = JSON.parse(JSON.stringify(appState));
    await firestoreApi.setDoc(storeDoc(storeNumber), {
      storeNumber: String(storeNumber),
      lastUpdated: firestoreApi.serverTimestamp(),
    }, { merge: true });
    await firestoreApi.setDoc(appStateDoc(storeNumber), {
      ...cleanState,
      storeNumber: String(storeNumber),
      lastUpdated: firestoreApi.serverTimestamp(),
    });
  }

  return {
    ready,
    createStoreIfMissing,
    getStoreState,
    saveStoreState,
  };
})();
