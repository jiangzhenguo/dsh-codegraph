// dsh-codegraph client half — 设置页「插件 → 可配置插件」里的 CodeGraph 卡片。
//
// 手写 __ModuleLoader__ factory bundle（CJS factory），与 dsh-rules-manager-client /
// dsh-token-usage 同构。注册 settings.plugin.item（key = 'dsh-codegraph'）：
// 宿主半通过 ctx.settings.installSection 把 Config 注册为 `dsh-codegraph` 设置命名空间，
// 本卡片经 ctx.settingsScope.bind({ namespace: 'dsh-codegraph' }) 读写它。
//
// 字段（对应 lib/index.js 的 Config）：
//   guideSearch  boolean  优先指引（系统提示词注入）
//   frontload    boolean  结构化 prompt 自动前置注入 <codegraph_context>（默认关）
//   surface      'core' | 'full'  工具面：4 个核心工具 / 全部 13 个
//
// 保存即写入设置文档（revision-fenced mutate），宿主半的 scope.watch 触发
// onChange 重挂 prompt 段 / 工具面 / frontload 监听器，无需重启。
window.__ModuleLoader__.load({
	id: "dsh-codegraph",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var createElement = React.createElement;

		var NS = "dsh-codegraph";

		var CSS = [
			".cg-card-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}",
			".cg-card-field+.cg-card-field{border-top:1px solid var(--dsw-alias-border-l2)}",
			// 折叠块卡片：对齐官方 PluginCard（ui-settings-plugins）的 card/header/
			// body/footer 结构与样式变量。
			".cg-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
			".cg-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".cg-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".cg-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
			".cg-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
			".cg-card-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
			".cg-card-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
			".cg-card-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
			".cg-card-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
			".cg-card-chevronOpen{transform:rotate(180deg)}",
			".cg-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:0 0 8px}",
			".cg-card-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
			".cg-card-head{align-items:center;gap:8px;display:flex}",
			".cg-card-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}",
			".cg-card-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
			".cg-card-badges{align-items:center;gap:8px;display:inline-flex}",
			".cg-card-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
			".cg-card-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px}",
			".cg-card-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			".cg-card-reset:disabled{cursor:default}",
			".cg-card-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px}",
			".cg-card-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
			".cg-card-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}",
			".cg-card-discard,.cg-card-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
			".cg-card-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}",
			".cg-card-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
			// 官方配色：实心 = label-primary 背景 + bg-layer-3 文字（此前 brand-primary
			// 背景 + label-primary 文字在部分主题下两者同色，Save 看不见）。
			".cg-card-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
			".cg-card-discard:disabled,.cg-card-save:disabled{opacity:.4;cursor:default}",
			".cg-card-checkbox{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}"
		].join("\n");

		// 卡片文案不走 ctx.locale：与 dsh-rules-manager-client 同策略，
		// 双语并排写出，避免为 3 个字段引入 locale 依赖。
		var COPY = {
			title: { zh: "CodeGraph 代码图谱", en: "CodeGraph" },
			description: {
				zh: "codegraph_* 工具、系统提示指引与结构化 prompt 前置注入的开关。",
				en: "codegraph_* tools, prompt guidance, and structural-prompt front-load."
			},
			guideSearch: { zh: "搜索指引（guideSearch）", en: "Search guidance (guideSearch)" },
			guideSearchHint: {
				zh: "在系统提示词里注入高优先级指引，让模型搜代码时优先用 codegraph_* 而不是 grep/read。",
				en: "Injects a high-priority system-prompt section so the model reaches for codegraph_* before grep/read."
			},
			frontload: { zh: "前置注入（frontload）", en: "Front-load context (frontload)" },
			frontloadHint: {
				zh: "结构性 prompt 进入收件箱时自动预跑 explore，把结果以 <codegraph_context> 注入本轮。默认关闭：注入内容会在整个会话窗口中驻留。",
				en: "Pre-runs codegraph_explore on structural prompts and steers the result in as <codegraph_context>. Off by default: the injection lingers in the context window for the session."
			},
			surface: { zh: "工具面（surface）", en: "Tool surface (surface)" },
			surfaceHint: {
				zh: "core 只注册 status/init/sync/explore 共 4 个工具；full 注册全部 13 个。",
				en: "core registers status/init/sync/explore only; full registers all 13 tools."
			},
			overridden: { zh: "已覆盖", en: "overridden" },
			unsaved: { zh: "未保存", en: "unsaved" },
			reset: { zh: "重置", en: "reset" },
			discard: { zh: "放弃", en: "Discard" },
			save: { zh: "保存", en: "Save" },
			saving: { zh: "保存中…", en: "Saving…" },
			unavailable: {
				zh: "此部署未组合 dsh-codegraph 插件，无法配置。",
				en: "dsh-codegraph is not composed in this deployment; nothing to configure."
			}
		};

		function t(key, locale) {
			var entry = COPY[key];
			return locale === "zh" ? entry.zh : entry.en;
		}

		// ---------- 表单模型（对齐 ui-settings-plugins 的 CardForm 语义）----------
		//
		// staged 编辑只在保存时写入；每个 settings 写是 revision-fenced 的文档
		// 变更。字段级 overridden 以 user 层是否携带该键为准（覆盖值等于组合
		// 层默认值仍是覆盖）。空勾选框的“清除”= unset（回到下层值）。
		function createCardController(ctx) {
			var scope = ctx.settingsScope.bind({ namespace: NS });
			var locale = ctx.locale;
			var staged = {}; // field -> { clear: boolean }
			var dirty = false;
			var saving = false;
			var failed = false;
			var listeners = new Set();
			var snapshot = null;

			scope.subscribe(function () { publish(); });

			function currentLocale() {
				var s = locale && locale.getSnapshot ? locale.getSnapshot() : null;
				return s && s.locale === "zh" ? "zh" : "en";
			}

			function publish() {
				var value = buildValue();
				if (snapshot !== null && shallowEqualSnapshot(snapshot, value)) return;
				snapshot = value;
				for (var fn of listeners) fn();
			}

			function shallowEqualSnapshot(a, b) {
				return a.ready === b.ready && a.writable === b.writable && a.dirty === b.dirty &&
					a.saving === b.saving && a.failed === b.failed && a.overridden.guideSearch === b.overridden.guideSearch &&
					a.overridden.frontload === b.overridden.frontload && a.overridden.surface === b.overridden.surface &&
					a.value.guideSearch === b.value.guideSearch && a.value.frontload === b.value.frontload &&
					a.value.surface === b.value.surface && a.locale === b.locale;
			}

			function sectionValue(field) {
				var s = scope.getSnapshot();
				return s.status === "ready" && s.value ? s.value[field] : undefined;
			}

			function userLayer() {
				return scope.getSnapshot().user;
			}

			function stored(field) {
				var user = userLayer();
				return user !== undefined && Object.prototype.hasOwnProperty.call(user, field);
			}

			function buildValue() {
				var s = scope.getSnapshot();
				var loc = currentLocale();
				return {
					ready: s.status === "ready",
					writable: s.writable === true,
					dirty: dirty,
					saving: saving,
					failed: failed,
					locale: loc,
					value: {
						guideSearch: staged.guideSearch === undefined
							? sectionValue("guideSearch") !== false
							: !staged.guideSearch.clear,
						frontload: staged.frontload === undefined
							? sectionValue("frontload") === true
							: !staged.frontload.clear,
						surface: staged.surface === undefined
							? (sectionValue("surface") === "full" ? "full" : "core")
							: (staged.surface.clear ? "core" : staged.surface.value)
					},
					overridden: {
						guideSearch: staged.guideSearch === undefined ? stored("guideSearch") : !staged.guideSearch.clear,
						frontload: staged.frontload === undefined ? stored("frontload") : !staged.frontload.clear,
						surface: staged.surface === undefined ? stored("surface") : !staged.surface.clear
					}
				};
			}

			function getSnapshot() {
				return snapshot !== null ? snapshot : (snapshot = buildValue());
			}

			function subscribe(fn) {
				listeners.add(fn);
				return function () { listeners.delete(fn); };
			}

			function stage(field, edit) {
				staged[field] = edit;
				failed = false;
				dirty = true;
				publish();
			}

			var actions = {
				editBool: function (field, checked) { stage(field, { clear: !checked }); },
				editSurface: function (field, value) { stage(field, { clear: false, value: value === "full" ? "full" : "core" }); },
				resetField: function (field) { stage(field, { clear: true }); },
				discard: function () {
					if (!dirty && !failed) return;
					staged = {};
					dirty = false;
					failed = false;
					publish();
				},
				save: function () {
					if (saving || !dirty) return;
					saving = true;
					failed = false;
					publish();
					var edits = staged;
					var writes = Object.keys(edits).map(function (field) {
						var edit = edits[field];
						return edit.clear
							? (stored(field) ? scope.unset(field) : Promise.resolve())
							: scope.set(field, edit.value !== undefined ? edit.value : !edit.clear);
					});
					Promise.all(writes).then(function () {
						// 写入答案会把新 view 折回 mirror 并触发 scope 订阅；这里
						// 仅落表单状态。写入失败（被拒绝）时保留草稿供修改。
						staged = {};
						dirty = false;
						saving = false;
						publish();
					}, function () {
						saving = false;
						failed = true;
						publish();
					});
				}
			};

			return {
				store: { getSnapshot: getSnapshot, subscribe: subscribe },
				actions: actions
			};
		}

		// ---------- 组件 ----------

		function FieldHead(props) {
			return createElement("div", { className: "cg-card-head" },
				createElement("label", { className: "cg-card-label", htmlFor: props.id }, props.label),
				props.overridden ? createElement("span", { className: "cg-card-badges" },
					createElement("span", { className: "cg-card-badge" }, props.overriddenLabel),
					createElement("button", {
						type: "button",
						className: "cg-card-reset",
						disabled: props.disabled,
						onClick: props.onReset
					}, props.resetLabel)
				) : null
			);
		}

		function BoolField(props) {
			return createElement("div", { className: "cg-card-field" },
				createElement(FieldHead, {
					id: props.id,
					label: props.label,
					overridden: props.overridden,
					overriddenLabel: props.overriddenLabel,
					resetLabel: props.resetLabel,
					disabled: props.disabled,
					onReset: props.onReset
				}),
				createElement("label", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: props.disabled ? "default" : "pointer" } },
					createElement("input", {
						id: props.id,
						type: "checkbox",
						className: "cg-card-checkbox",
						checked: props.checked === true,
						disabled: props.disabled,
						onChange: function (e) { props.onChange(e.target.checked); }
					}),
					createElement("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)" } },
						props.checked === true ? "开启" : "关闭")
				),
				createElement("p", { className: "cg-card-hint" }, props.hint)
			);
		}

		function SelectField(props) {
			return createElement("div", { className: "cg-card-field" },
				createElement(FieldHead, {
					id: props.id,
					label: props.label,
					overridden: props.overridden,
					overriddenLabel: props.overriddenLabel,
					resetLabel: props.resetLabel,
					disabled: props.disabled,
					onReset: props.onReset
				}),
				createElement("select", {
					id: props.id,
					className: "cg-card-select",
					value: props.value,
					disabled: props.disabled,
					onChange: function (e) { props.onChange(e.target.value); }
				},
					createElement("option", { value: "core" }, "core — 4 个核心工具"),
					createElement("option", { value: "full" }, "full — 全部 13 个工具")),
				createElement("p", { className: "cg-card-hint" }, props.hint)
			);
		}

		// 与官方 PluginCard 同构的折叠块：header 是整卡展开/收起按钮（标题 +
		// 描述 + 未保存徽标 + 旋转 chevron），body 只在展开时渲染，footer 收纳
		// 保存/放弃。staged 编辑在收起后保留。
		function CodeGraphCard(props) {
			var state = props.useCodeGraphCard(function (s) { return s; });
			var openState = React.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			if (!state.ready) {
				return createElement("li", { className: "cg-card" },
					createElement("p", { className: "cg-card-hint", style: { margin: "12px 16px" } }, t("unavailable", state.locale)));
			}
			var disabled = !state.writable || state.saving;
			var blocked = !state.dirty || state.saving;
			var fields = [
				createElement(BoolField, {
					id: "plugin-config-codegraph-guide-search",
					key: "guideSearch",
					label: t("guideSearch", state.locale),
					hint: t("guideSearchHint", state.locale),
					checked: state.value.guideSearch,
					overridden: state.overridden.guideSearch,
					overriddenLabel: t("overridden", state.locale),
					resetLabel: t("reset", state.locale),
					disabled: disabled,
					onChange: function (checked) { props.editBool("guideSearch", checked); },
					onReset: function () { props.resetField("guideSearch"); }
				}),
				createElement(BoolField, {
					id: "plugin-config-codegraph-frontload",
					key: "frontload",
					label: t("frontload", state.locale),
					hint: t("frontloadHint", state.locale),
					checked: state.value.frontload,
					overridden: state.overridden.frontload,
					overriddenLabel: t("overridden", state.locale),
					resetLabel: t("reset", state.locale),
					disabled: disabled,
					onChange: function (checked) { props.editBool("frontload", checked); },
					onReset: function () { props.resetField("frontload"); }
				}),
				createElement(SelectField, {
					id: "plugin-config-codegraph-surface",
					key: "surface",
					label: t("surface", state.locale),
					hint: t("surfaceHint", state.locale),
					value: state.value.surface,
					overridden: state.overridden.surface,
					overriddenLabel: t("overridden", state.locale),
					resetLabel: t("reset", state.locale),
					disabled: disabled,
					onChange: function (value) { props.editSurface("surface", value); },
					onReset: function () { props.resetField("surface"); }
				})
			];
			return createElement("li", { className: open ? "cg-card cg-cardOpen" : "cg-card" },
				createElement("button", {
					type: "button",
					className: "cg-card-header",
					"aria-expanded": open,
					onClick: function () { setOpen(!open); }
				},
					createElement("span", { className: "cg-card-headText" },
						createElement("span", { className: "cg-card-name" }, t("title", state.locale)),
						createElement("span", { className: "cg-card-description" }, t("description", state.locale))),
					state.dirty ? createElement("span", { className: "cg-card-pending" }, t("unsaved", state.locale)) : null,
					createElement("span", {
						className: open ? "cg-card-chevron cg-card-chevronOpen" : "cg-card-chevron",
						"aria-hidden": "true",
						style: { display: "inline-flex" }
					}, "▾")),
				open ? createElement("div", { className: "cg-card-body" },
					!state.writable ? createElement("p", { className: "cg-card-hint", style: { margin: "12px 0 0" } }, t("unavailable", state.locale)) : null,
					fields,
					createElement("div", { className: "cg-card-footer" },
						state.failed ? createElement("p", { className: "cg-card-failed" }, "保存未生效，请重试。") : null,
						createElement("button", {
							type: "button",
							className: "cg-card-discard",
							disabled: !state.dirty || state.saving,
							onClick: props.discard
						}, t("discard", state.locale)),
						createElement("button", {
							type: "button",
							className: "cg-card-save",
							disabled: blocked,
							onClick: props.save
						}, state.saving ? t("saving", state.locale) : t("save", state.locale)))) : null
			);
		}

		// ---------- apply ----------

		var inject = ["slots", "settingsScope", "locale", "connection"];

		function apply(ctx) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-codegraph";
			tag.textContent = CSS;
			document.head.appendChild(tag);

			var controller = createCardController(ctx);

			ctx.slots.inject("settings.plugin.item", function () {
				return ctx.slots.register({
					name: "settings.plugin.item",
					key: NS,
					inject: function () {
						return {
							hooks: { codeGraphCard: controller.store },
							...controller.actions
						};
					}
				}, CodeGraphCard);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "dsh-codegraph";
		return module.exports;
	}
});
