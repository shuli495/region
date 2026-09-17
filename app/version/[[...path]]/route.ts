import { handle } from '../../service/Http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => handle(request, 'version');
export const POST = GET;
