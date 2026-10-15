/*
 * Yes/no questions to the editor, as UXP modal dialogs.
 *
 * A <dialog> opened with uxpShowModal() blocks Premiere until it closes, and
 * resolves with whatever close() was given -- or "reasonCanceled" for Esc or
 * the title bar's close (Premiere UXP docs, 25.6+). A panel can only have one
 * modal open at a time, so questions are asked one after another.
 *
 * The dialog is built when it is needed and removed afterwards: the plugin
 * runs with no panel open, and nothing here may depend on the panel's DOM.
 * Buttons are Spectrum <sp-button>s, as in Adobe's Premiere dialog example;
 * UXP ignores styling on a plain <button>.
 */

let chain = Promise.resolve();

/*
 * Ask a question. Resolves true for yes and false for no or a dismissal.
 * Rejects only when no dialog could be shown at all.
 */
function confirm(question) {
  const run = chain.then(() => show(question));
  chain = run.catch(() => {});
  return run;
}

async function show({ title = "Shade Tracker", heading, lines = [], yes = "Yes", no = "No" }) {
  if (typeof document === "undefined") throw new Error("no document to show a dialog in");
  const el = (tag, text, style) => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (style) e.setAttribute("style", style);
    return e;
  };

  const dlg = el("dialog", null, "background-color: #1e1e1e; color: #e8e6e1;");
  const body = el("div", null, "display: flex; flex-direction: column; padding: 4px;");
  if (heading) body.appendChild(el("div", heading, "font-size: 14px; font-weight: bold; margin-bottom: 10px;"));
  for (const line of lines) body.appendChild(el("div", line, "font-size: 12px; margin-bottom: 6px;"));

  const buttons = el("div", null, "display: flex; justify-content: flex-end; margin-top: 14px;");
  const noBtn = el("sp-button", no, "margin-right: 8px;");
  noBtn.setAttribute("variant", "secondary");
  const yesBtn = el("sp-button", yes);
  yesBtn.setAttribute("variant", "cta");
  noBtn.addEventListener("click", () => dlg.close("no"));
  yesBtn.addEventListener("click", () => dlg.close("yes"));
  buttons.appendChild(noBtn);
  buttons.appendChild(yesBtn);
  body.appendChild(buttons);
  dlg.appendChild(body);
  document.body.appendChild(dlg);

  try {
    if (typeof dlg.uxpShowModal !== "function") throw new Error("uxpShowModal is not available here");
    const answer = await dlg.uxpShowModal({ title, resize: "none", size: { width: 420, height: 120 + 26 * lines.length } });
    return answer === "yes";
  } finally {
    dlg.remove();
  }
}

module.exports = { confirm };
