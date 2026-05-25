import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, getAccessKey, getSessionSalt, hashAccessKey } from "@/lib/auth";

const PUBLIC_PATHS = ["/unlock", "/api/unlock", "/api/logout", "/favicon.ico"];

function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.includes(pathname) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/assets")
  );
}

function hasValidCronSecret(request: NextRequest): boolean {
  if (!(request.nextUrl.pathname.startsWith("/api/scan") || request.nextUrl.pathname.startsWith("/api/run"))) {
    return false;
  }

  const ravenCronSecret = process.env.RAVEN_CRON_SECRET?.trim();
  const vercelCronSecret = process.env.CRON_SECRET?.trim();
  const validSecrets = [ravenCronSecret, vercelCronSecret].filter(Boolean);

  if (!validSecrets.length) {
    return false;
  }

  const querySecret = request.nextUrl.searchParams.get("secret")?.trim();
  const headerSecret = request.headers.get("x-raven-cron-secret")?.trim();
  const authHeader = request.headers.get("authorization")?.trim();

  return validSecrets.some((secret) => (
    querySecret === secret ||
    headerSecret === secret ||
    authHeader === `Bearer ${secret}`
  ));
}

export async function middleware(request: NextRequest) {
  const accessKey = getAccessKey();

  if (!accessKey || isPublicPath(request.nextUrl.pathname) || hasValidCronSecret(request)) {
    return NextResponse.next();
  }

  const expected = await hashAccessKey(accessKey, getSessionSalt());
  const actual = request.cookies.get(AUTH_COOKIE_NAME)?.value;

  if (actual === expected) {
    return NextResponse.next();
  }

  const unlockUrl = new URL("/unlock", request.url);
  unlockUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(unlockUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
