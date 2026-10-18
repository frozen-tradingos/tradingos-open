import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { transpileModule, JsxEmit, ModuleKind } from "typescript";

test("long details use native modal semantics and return focus without scrolling", async () => {
  const source = await readFile(new URL("../app/DetailSheet.tsx", import.meta.url), "utf8");
  const require = createRequire(import.meta.url), refs = [], exports = {};
  const { outputText } = transpileModule(source, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS } });
  new Function("exports", "require", outputText)(exports, (name) => name === "react" ? {
    useId: () => "detail-heading",
    useRef: () => { const ref = { current: null }; refs.push(ref); return ref; },
  } : require(name));
  const content = "原始证据不丢失";
  const view = exports.DetailSheet({ title: "观察依据", label: "查看详情", children: content });
  const [trigger, dialog] = view.props.children;
  let shown = false, closed = false, focusOptions;
  refs[0].current = { showModal: () => { shown = true; }, close: () => { closed = true; dialog.props.onClose(); } };
  refs[1].current = { focus: (options) => { focusOptions = options; } };
  assert.equal(trigger.type, "button");
  assert.equal(trigger.props.type, "button");
  assert.equal(trigger.props["aria-haspopup"], "dialog");
  assert.equal(dialog.type, "dialog");
  assert.equal(dialog.props.open, undefined);
  assert.equal(dialog.props["aria-labelledby"], "detail-heading");
  assert.equal(dialog.props.children[1].props.children, content);
  trigger.props.onClick();
  assert.ok(shown);
  const closeButton = dialog.props.children[0].props.children[1];
  assert.equal(closeButton.props["aria-label"], "关闭详情");
  closeButton.props.onClick();
  assert.ok(closed);
  assert.deepEqual(focusOptions, { preventScroll: true });
});
