/*
 * SnapShrink — client-side image compression.
 *
 * Pipeline per image:
 *   File -> createImageBitmap (respects EXIF orientation)
 *        -> draw onto a canvas, optionally downscaled to a max dimension
 *        -> canvas.toBlob(mime, quality)
 *        -> keep whichever of {original, re-encoded} is smaller when the
 *           user chose "Keep original" format.
 *
 * No network. No dependencies beyond tinyzip (bundled). Everything is in memory.
 */
(function () {
  "use strict";

  const els = {
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("fileInput"),
    browseBtn: document.getElementById("browseBtn"),
    controls: document.getElementById("controls"),
    summary: document.getElementById("summary"),
    grid: document.getElementById("grid"),
    format: document.getElementById("format"),
    quality: document.getElementById("quality"),
    qualityVal: document.getElementById("qualityVal"),
    maxDim: document.getElementById("maxDim"),
    downloadAll: document.getElementById("downloadAll"),
    clearAll: document.getElementById("clearAll"),
    cardTpl: document.getElementById("cardTpl"),
    statCount: document.getElementById("statCount"),
    statBefore: document.getElementById("statBefore"),
    statAfter: document.getElementById("statAfter"),
    statSaved: document.getElementById("statSaved"),
  };

  /** @type {Array<{id:number,file:File,card:HTMLElement,bitmap?:ImageBitmap,outBlob?:Blob,outName?:string,ok:boolean}>} */
  const items = [];
  let nextId = 1;
  let reprocessToken = 0;

  const EXT = {
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/png": "png",
    "image/avif": "avif",
    "image/gif": "gif",
  };

  // ── helpers ─────────────────────────────────────────────
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  function baseName(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }

  function chosenMime(file) {
    const sel = els.format.value;
    return sel === "keep" ? file.type || "image/jpeg" : sel;
  }

  // Encode a bitmap to a Blob at a target mime/quality/size.
  function encode(bitmap, mime, quality, maxDim) {
    let { width, height } = bitmap;
    if (maxDim > 0 && Math.max(width, height) > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(
        function (blob) {
          if (blob) resolve(blob);
          else reject(new Error("encode-failed"));
        },
        mime,
        quality
      );
    });
  }

  // ── per-item processing ─────────────────────────────────
  async function processItem(item, token) {
    const card = item.card;
    try {
      if (!item.bitmap) {
        item.bitmap = await createImageBitmap(item.file, { imageOrientation: "from-image" });
      }
      const mime = chosenMime(item.file);
      const quality = Number(els.quality.value) / 100;
      const maxDim = Number(els.maxDim.value);

      let blob;
      try {
        blob = await encode(item.bitmap, mime, quality, maxDim);
      } catch (e) {
        // Browser can't encode this mime (e.g. AVIF) — fall back to WebP.
        blob = await encode(item.bitmap, "image/webp", quality, maxDim);
      }
      if (token !== reprocessToken) return; // superseded by a newer run

      // If "keep original" and re-encoding made it bigger, keep the original bytes.
      let outBlob = blob;
      let usedType = blob.type || mime;
      if (els.format.value === "keep" && maxDim === 0 && blob.size >= item.file.size) {
        outBlob = item.file;
        usedType = item.file.type;
      }

      const ext = EXT[usedType] || "img";
      item.outBlob = outBlob;
      item.outName = baseName(item.file.name) + "." + ext;
      item.ok = true;

      renderResult(card, item.file.size, outBlob.size);
      const dl = card.querySelector(".dl");
      dl.disabled = false;
      dl.onclick = function () {
        downloadBlob(item.outBlob, item.outName);
      };
    } catch (err) {
      item.ok = false;
      card.classList.add("error");
      card.querySelector(".after").textContent = "failed";
      card.querySelector(".pill").hidden = true;
    }
    updateSummary();
  }

  function renderResult(card, before, after) {
    const savedPct = before > 0 ? (1 - after / before) * 100 : 0;
    card.querySelector(".before").textContent = fmtBytes(before);
    card.querySelector(".after").textContent = fmtBytes(after);
    const pill = card.querySelector(".pill");
    if (savedPct >= 0) {
      pill.textContent = "−" + savedPct.toFixed(0) + "%";
      pill.classList.remove("worse");
    } else {
      pill.textContent = "+" + Math.abs(savedPct).toFixed(0) + "%";
      pill.classList.add("worse");
    }
    card.querySelector(".bar-fill").style.width = Math.max(0, Math.min(100, savedPct)) + "%";
  }

  // ── batch orchestration ─────────────────────────────────
  async function reprocessAll() {
    const token = ++reprocessToken;
    for (const item of items) {
      item.card.querySelector(".after").textContent = "…";
      item.card.querySelector(".pill").textContent = "…";
      item.card.querySelector(".pill").hidden = false;
      item.card.classList.remove("error");
      item.card.querySelector(".dl").disabled = true;
    }
    // Process sequentially to keep memory + UI responsive on big batches.
    for (const item of items) {
      if (token !== reprocessToken) return;
      await processItem(item, token);
    }
  }

  function updateSummary() {
    const done = items.filter((i) => i.ok && i.outBlob);
    const before = items.reduce((s, i) => s + i.file.size, 0);
    const after = done.reduce((s, i) => s + i.outBlob.size, 0);
    const doneBefore = done.reduce((s, i) => s + i.file.size, 0);
    els.statCount.textContent = String(items.length);
    els.statBefore.textContent = fmtBytes(before);
    els.statAfter.textContent = fmtBytes(after);
    const pct = doneBefore > 0 ? (1 - after / doneBefore) * 100 : 0;
    els.statSaved.textContent = (pct >= 0 ? "−" : "+") + Math.abs(pct).toFixed(0) + "%";
    els.downloadAll.disabled = done.length === 0;
  }

  // ── adding / removing ───────────────────────────────────
  function addFiles(fileList) {
    const imgs = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    els.controls.hidden = false;
    els.summary.hidden = false;

    for (const file of imgs) {
      const frag = els.cardTpl.content.cloneNode(true);
      const card = frag.querySelector(".card");
      const nameEl = card.querySelector(".name");
      nameEl.textContent = file.name;
      nameEl.title = file.name;
      card.querySelector(".before").textContent = fmtBytes(file.size);

      const img = card.querySelector(".thumb img");
      const url = URL.createObjectURL(file);
      img.src = url;
      img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(url);

      const item = { id: nextId++, file, card, ok: false };
      card.querySelector(".rm").onclick = () => removeItem(item);
      items.push(item);
      els.grid.appendChild(card);
    }
    updateSummary();
    reprocessAll();
  }

  function removeItem(item) {
    const idx = items.indexOf(item);
    if (idx >= 0) items.splice(idx, 1);
    item.card.remove();
    if (item.bitmap && item.bitmap.close) item.bitmap.close();
    if (items.length === 0) {
      els.controls.hidden = true;
      els.summary.hidden = true;
    }
    updateSummary();
  }

  function clearAll() {
    items.slice().forEach(removeItem);
  }

  // ── downloads ───────────────────────────────────────────
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadAll() {
    const done = items.filter((i) => i.ok && i.outBlob);
    if (done.length === 0) return;
    if (done.length === 1) {
      downloadBlob(done[0].outBlob, done[0].outName);
      return;
    }
    els.downloadAll.disabled = true;
    els.downloadAll.textContent = "Zipping…";
    try {
      const seen = {};
      const files = [];
      for (const i of done) {
        let name = i.outName;
        if (seen[name]) name = baseName(name) + "-" + i.id + name.slice(name.lastIndexOf("."));
        seen[name] = true;
        files.push({ name, data: new Uint8Array(await i.outBlob.arrayBuffer()) });
      }
      const zip = tinyzip.makeZip(files);
      downloadBlob(zip, "snapshrink-" + done.length + "-images.zip");
    } finally {
      els.downloadAll.textContent = "Download all (.zip)";
      els.downloadAll.disabled = false;
    }
  }

  // ── events ──────────────────────────────────────────────
  els.browseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.fileInput.click();
  });
  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", (e) => {
    addFiles(e.target.files);
    els.fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("dragging");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove("dragging");
    })
  );
  els.dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  // Allow dropping anywhere on the page once images are loaded.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!els.dropzone.contains(e.target) && e.dataTransfer && e.dataTransfer.files) {
      addFiles(e.dataTransfer.files);
    }
  });

  let debounce;
  function onControlChange() {
    clearTimeout(debounce);
    debounce = setTimeout(reprocessAll, 120);
  }
  els.format.addEventListener("change", onControlChange);
  els.maxDim.addEventListener("change", onControlChange);
  els.quality.addEventListener("input", () => {
    els.qualityVal.textContent = els.quality.value;
    onControlChange();
  });
  els.downloadAll.addEventListener("click", downloadAll);
  els.clearAll.addEventListener("click", clearAll);
})();
