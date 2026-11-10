import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "기출 오답노트",
  description: "학생별 시험 오답 기록과 오답 추출",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
