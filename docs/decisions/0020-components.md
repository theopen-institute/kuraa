# 0020 · Components

The parts that give the app its abilities (document **formats**, language **engines**, and the
**environments** code runs in) are called **components**, in the interface and in the code. They
were "plugins".

**Why.** People using the app should not need technical words, and these parts are essential, not
extras: without a format a file does not open, without an engine nothing runs. "Plugin" and
"extension" read as technical; "add-on" reads as optional; "module" already means a JavaScript
module and a format's editor module. "Component" also names something in the Vue client (its
`.vue` files); people using the app never see that, and the code keeps the two apart by context.

**Names.**

| Was | Now |
| --- | --- |
| Plugins… (menu and panel) | Components… |
| `--plugin` (host, desktop) | `--component` |
| `RunPlugin`, `definePlugin` (`@kuraa/run-kit`) | `RunComponent`, `defineRunComponent` |
| `@kuraa/run-plugins`, `standardRunPlugins` | `@kuraa/run-components`, `standardRunComponents` |
| `loadRunPlugins`, `RunOptions.plugins` | `loadRunComponents`, `RunOptions.components` |
| `GET /api/plugins` | `GET /api/components` |

`defineRunComponent`, not `defineComponent`, so it is never mistaken for Vue's function of that
name. The contract's shape and `RUN_API_VERSION` are unchanged. "Plugins" that belong to other
libraries keep their names: ProseMirror plugins (what a format's editor module returns), Vite and
ESLint plugins. Earlier decision records keep the word they used at the time.
