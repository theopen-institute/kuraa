# 0016 · The client's components are Vue

The client's window frame (the sidebar, the menu, the dialogs, history, the read-only views) is
written in Vue 3 single-file components with `<script setup lang="ts">`, in place of React. The
people maintaining it know Vue.

**Only the frame.** Nothing a plugin implements depends on the framework. Run plugins live on the
host. Format cores are headless. Format editor modules hand the client ProseMirror plugins and node
views, which are plain DOM, and ask questions through `ctx.ui` (`ask.ts`, also plain DOM). A plugin
written for the React client works unchanged. If plugins come to contribute UI of their own (a menu
section, a panel), the contract will hand them an element to mount into, not a Vue component, so
plugins stay free to use any framework or none.

**Editor objects are never reactive.** ProseMirror's view, CodeMirror, the room connection, the
chunk runner, the `HostApi`, the type registry and document types are held in `shallowRef`, plain
variables, or marked with `markRaw`. Vue's deep proxies would slow them down and break their
identity checks. Objects that change outside Vue and announce it through `subscribe` (the chunk
runner) are observed with `useLive` (`packages/client/src/vue.ts`), which re-renders on each
announcement without proxying the object.

**Checks.** `vue-tsc` type-checks the repository (it also reads `.vue` files), and
`eslint-plugin-vue` (its `essential` rules) lints them. The browser tests find elements by test id
and visible text only, so the same tests cover the client before and after the switch.
