// Blob downloads use the browser's native download API. Kept global for existing callers.
window.saveAs = (blob, filename) => {
    if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob to download');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = String(filename);
    link.hidden = true;
    document.body.appendChild(link);
    try { link.click(); }
    finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
};
