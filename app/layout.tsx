import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
    title: 'Region · 行政区划控制台',
    description: '全球行政区划数据与版本管理',
};
export default function Layout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="zh-CN">
            <body>{children}</body>
        </html>
    );
}
