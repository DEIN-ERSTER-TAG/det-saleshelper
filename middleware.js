const REALM = 'DET SalesHelper';

function isAuthorized(request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;

  const expectedUser = process.env.SITE_AUTH_USER || 'det';
  const expectedPass = process.env.SITE_AUTH_PASSWORD;
  if (!expectedPass) return false;

  const decoded = atob(authHeader.slice('Basic '.length));
  const sepIndex = decoded.indexOf(':');
  if (sepIndex === -1) return false;

  const user = decoded.slice(0, sepIndex);
  const pass = decoded.slice(sepIndex + 1);

  return user === expectedUser && pass === expectedPass;
}

export default function middleware(request) {
  if (isAuthorized(request)) return;

  return new Response('Zugriff verweigert', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${REALM}"` },
  });
}

export const config = {
  matcher: '/((?!favicon.ico|api/cleanup).*)',
};
