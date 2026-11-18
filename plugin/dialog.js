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
 * Laid out as Adobe's own UXP dialogs are, so it reads like Premiere rather
 * than like the panel: the plugin's name in the title bar, then a Spectrum
 * <sp-heading>, <sp-divider>, <sp-body> text and a right-aligned button
 * group -- the cancelling choice as a secondary quiet button, the action as
 * the cta on the right. No colours or fonts are set here, so Premiere's
 * theme and font apply (it used to hard-code a dark background and px
 * sizes). Buttons say what they do ("Unpin"), not "Yes"/"No". UXP ignores
 * styling on a plain <button>, hence <sp-button>.
 */

let chain = Promise.resolve();

/*
 * Ask a question. Resolves true for yes and false for no or a dismissal.
 * Rejects only when no dialog could be shown at all.
 */
function confirm(question) {
  return ask(question).then((r) => r.yes);
}

/*
 * Like confirm, with an optional checkbox ({ checkbox: "Do this every time" }).
 * Resolves { yes, checked }.
 */
function ask(question) {
  const run = chain.then(() => show(question));
  chain = run.catch(() => {});
  return run;
}

async function show({ title = "Shade Linker", heading, lines = [], yes = "Yes", no = "No", checkbox = null }) {
  if (typeof document === "undefined") throw new Error("no document to show a dialog in");
  const el = (tag, text, style) => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (style) e.setAttribute("style", style);
    return e;
  };

  const dlg = el("dialog");
  const form = el("form", null, "width: 400px;");
  form.setAttribute("method", "dialog");
  if (heading) form.appendChild(el("sp-heading", heading));
  const divider = el("sp-divider", null, "margin-bottom: 12px;");
  divider.setAttribute("size", "large");
  form.appendChild(divider);
  for (const line of lines) form.appendChild(el("sp-body", line));
  const box = checkbox ? el("sp-checkbox", checkbox, "margin-top: 12px;") : null;
  if (box) form.appendChild(box);

  const footer = el("footer", null, "display: flex; justify-content: flex-end; margin-top: 20px;");
  if (no) {                  // no: null makes it a notice with one button
    const noBtn = el("sp-button", no, "margin-right: 12px;");
    noBtn.setAttribute("variant", "secondary");
    noBtn.setAttribute("quiet", "");
    noBtn.addEventListener("click", () => dlg.close("no"));
    footer.appendChild(noBtn);
  }
  const yesBtn = el("sp-button", yes);
  yesBtn.setAttribute("variant", "cta");
  yesBtn.addEventListener("click", () => dlg.close("yes"));
  footer.appendChild(yesBtn);
  form.appendChild(footer);
  dlg.appendChild(form);
  document.body.appendChild(dlg);

  try {
    if (typeof dlg.uxpShowModal !== "function") throw new Error("uxpShowModal is not available here");
    // No size: the dialog fits its content, as Premiere's own do.
    const answer = await dlg.uxpShowModal({ title, resize: "none" });
    return { yes: answer === "yes", checked: !!(box && box.checked) };
  } finally {
    dlg.remove();
  }
}

/* Tell the editor something; one OK button. Resolves when it is closed. */
function notify({ heading, lines = [] }) {
  return confirm({ heading, lines, yes: "OK", no: null }).then(() => undefined);
}

module.exports = { confirm, ask, notify };
