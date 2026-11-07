/**
 * Client 插件入口：把「流程编排工作室」注册成一个整页面板 + 侧栏入口。
 *
 * 面板 key 与侧栏 id 必须一致 —— 侧栏按钮点击时走的是
 * `layout.selectPanel(id)`，只有同一个 key 才能把请求派发到这个组件。
 *
 * @module @feiyueve/dsh-flow-studio/client/plugin
 */

import { StudioIcon } from './icons.js'
import { FlowStudioPage } from './page.js'
import { bindReact } from './runtime.js'

/** 侧栏 id 与 main 槽 key，两者必须是同一个值。 */
export const PANEL_ID = 'flow-studio'

/**
 * 由 entry.js 的 factory 调用；React 在这里注入到共享运行时。
 * @param {(name: string) => any} require 宿主的浏览器模块表
 */
export function createPlugin(require) {
  bindReact(require('react'))
  return {
    name: 'flow-studio',
    inject: ['slots'],
    apply(ctx) {
      /**
       * 0.10 R4：宿主跳转节点会话。**懒取** `uiWorkspace`（不写进 inject 数组：
       * 服务缺失时必需注入会让整个面板停在 PENDING），每次调用时读一次，
       * try/catch 包住，返回 boolean，不 await。
       */
      const openSession = target => {
        let workspace
        try {
          workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
        } catch {
          return false
        }
        if (!workspace || typeof workspace.openSession !== 'function') return false
        try {
          workspace.openSession(target)
          return true
        } catch {
          return false
        }
      }

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ openSession }),
      }, FlowStudioPage))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: '流程编排',
      }, StudioIcon))
    },
  }
}
