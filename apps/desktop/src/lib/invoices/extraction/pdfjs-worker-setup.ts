// Wires the pdfjs worker URL at renderer startup.
// Must be imported before any call to pdfjs.getDocument().
// The ?worker&url Vite query resolves the worker bundle path at build time.
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?worker&url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
