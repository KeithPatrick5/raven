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

export async function middleware(request: NextRequest) {
  const accessKey = getAccessKey();

  if (!accessKey || isPublicPath(request.nextUrl.pathname)) {
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
