import { json } from './_shared/helpers';

export const onRequest: PagesFunction = async (context) => {
  try {
    return await context.next();
  } catch (error) {
    console.error('Unhandled Pages Function error', error);
    const pathname = new URL(context.request.url).pathname;
    if (pathname.startsWith('/api/')) {
      return json({
        ok: false,
        message: '서버 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      }, 500);
    }
    return new Response('Internal Server Error', { status: 500 });
  }
};
