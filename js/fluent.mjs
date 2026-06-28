// fluent.mjs — a starter WinUI 3 / Fluent control pack for PollyUI, with each
// control authored as a stateless Vue SFC and registered as a custom element tag.
//
//   import './js/pollyui.mjs';   // base tags + h
//   import './js/fluent.mjs';    // registers <fluent-card>, <fluent-button>, …
//   h('fluent-card', { title: 'Welcome' },
//     h('fluent-button', { accent: true, onClick }, 'Get'))
//
// Controls are stateless (props in, vnode out; <slot/> = children) — app state
// lifts to the top-level setup, matching PollyUI's call-time tag resolution.

import { defineTags } from './js/reconciler.mjs';
import { compileSFCTag } from './js/sfc.mjs';

// Fluent card: rounded hairline-bordered surface with an optional title + slot.
export const FluentCard = compileSFCTag(`
  <template>
    <view :style="{ borderRadius:'8', borderWidth:'1', borderColor:'#e5e5e5', backgroundColor:'#ffffff', padding:'20', gap:'10', flexDirection:'column' }">
      <text v-if="title" :style="{ fontSize:'18', fontWeight:'bold', color:'#1a1a1a' }">{{ title }}</text>
      <slot/>
    </view>
  </template>
  <script>export default { props: ['title'] }</script>
`);

// Fluent button: accent (filled #0067C0) or standard (subtle), with hover.
export const FluentButton = compileSFCTag(`
  <template>
    <view :style="{ height:'32', paddingLeft:'20', paddingRight:'20', borderRadius:'4', alignItems:'center', justifyContent:'center', backgroundColor: accent ? '#0067c0' : '#fbfbfb', borderWidth: accent ? '0' : '1', borderColor:'#d0d0d0' }"
          :hoverStyle="{ backgroundColor: accent ? '#1975c5' : '#f0f0f0' }" @click="onClick">
      <text :style="{ color: accent ? '#ffffff' : '#1a1a1a', fontSize:'14', fontWeight:'600' }"><slot/></text>
    </view>
  </template>
  <script>export default { props: ['accent','onClick'], setup(p){ return { accent: !!p.accent, onClick: p.onClick }; } }</script>
`);

// Fluent InfoBar: an accent dot + title/message, on a tinted surface.
export const FluentInfoBar = compileSFCTag(`
  <template>
    <view :style="{ flexDirection:'row', gap:'12', alignItems:'center', padding:'14', borderRadius:'6', backgroundColor:'#f0f6fc', borderWidth:'1', borderColor:'#cfe4f7' }">
      <view :style="{ width:'8', height:'8', borderRadius:'4', backgroundColor:'#0067c0' }"></view>
      <view :style="{ flexDirection:'column', gap:'2', flexGrow:'1' }">
        <text :style="{ fontSize:'14', fontWeight:'600', color:'#1a1a1a' }">{{ title }}</text>
        <text v-if="message" :style="{ fontSize:'13', color:'#5f6368' }">{{ message }}</text>
      </view>
    </view>
  </template>
  <script>export default { props: ['title','message'] }</script>
`);

// Fluent ToggleSwitch (visual; controlled via `on` + onToggle).
export const FluentToggle = compileSFCTag(`
  <template>
    <view :style="{ width:'40', height:'20', borderRadius:'10', position:'relative', backgroundColor: on ? '#0067c0' : '#d0d0d0' }" @click="onToggle">
      <view :style="{ position:'absolute', top:'3', left: on ? '23' : '3', width:'14', height:'14', borderRadius:'7', backgroundColor:'#ffffff' }"></view>
    </view>
  </template>
  <script>export default { props: ['on','onToggle'], setup(p){ return { on: !!p.on, onToggle: p.onToggle }; } }</script>
`);

defineTags({
  'fluent-card': FluentCard,
  'fluent-button': FluentButton,
  'fluent-infobar': FluentInfoBar,
  'fluent-toggle': FluentToggle,
});
