/**
 * 환율 조회 실패 시 공통 폴백값.
 * 앱(page.tsx)과 텔레그램 크론이 서로 다른 폴백을 쓰면 조회 실패 날
 * 두 화면의 평가액·수익률이 어긋나므로 반드시 이 상수를 공유한다.
 */
export const FALLBACK_USD_KRW = 1400;
export const FALLBACK_EUR_KRW = 1500;
