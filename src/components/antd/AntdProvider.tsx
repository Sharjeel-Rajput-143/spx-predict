"use client";

import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App, ConfigProvider, theme, type ThemeConfig } from "antd";
import { useSyncExternalStore, type ReactNode } from "react";

/**
 * Ant Design for the whole app: its styles are collected on the server (no flash of unstyled content), placed in their own CSS layer
 * between Tailwind's base and its utilities (so a Tailwind class on an Ant Design component still wins, and Tailwind's reset never fights
 * it), and its colours are this app's own palette (globals.css), in light and in dark.
 */

const font = { fontFamily: "inherit", fontSize: 14 };

/** The palette in globals.css, as plain colours (Ant Design works its shades out from them, so a CSS variable can't be used). */
export const LIGHT: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    ...font,
    colorPrimary: "#2962ff",
    colorInfo: "#2962ff",
    colorSuccess: "#089981",
    colorError: "#f23645",
    colorWarning: "#f59e0b",
    colorBgBase: "#ffffff",
    colorBgLayout: "#f5f6f8",
    colorTextBase: "#0e1116",
    colorTextSecondary: "#69717d",
    colorTextTertiary: "#9aa1ab",
    colorBorder: "#e2e5ea",
    colorBorderSecondary: "#e2e5ea",
    borderRadius: 8,
    borderRadiusLG: 16,
  },
};

export const DARK: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    ...font,
    colorPrimary: "#2962ff",
    colorInfo: "#2962ff",
    colorSuccess: "#089981",
    colorError: "#f23645",
    colorWarning: "#f59e0b",
    colorBgBase: "#1e222d",
    colorBgContainer: "#1e222d",
    colorBgElevated: "#262b38",
    colorBgLayout: "#131722",
    colorTextBase: "#d1d4dc",
    colorTextSecondary: "#787b86",
    colorTextTertiary: "#565a68",
    colorBorder: "#2a2e39",
    colorBorderSecondary: "#2a2e39",
    borderRadius: 8,
    borderRadiusLG: 16,
  },
};

/** Whether the page is in dark mode: the app's own switch puts a "dark" class on <html>, so this follows that class. */
function subscribeDark(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
const isDark = () => document.documentElement.classList.contains("dark");

export function AntdProvider({ children }: { children: ReactNode }) {
  const dark = useSyncExternalStore(subscribeDark, isDark, () => false);
  return (
    <AntdRegistry layer>
      <ConfigProvider theme={dark ? DARK : LIGHT}>
        <App component={false}>{children}</App>
      </ConfigProvider>
    </AntdRegistry>
  );
}
