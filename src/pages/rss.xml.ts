import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getArticles, getFilms } from '../lib/content';

export async function GET(context: APIContext) {
	const [articles, films] = await Promise.all([getArticles(), getFilms()]);
	const items = [
		...articles.map((a) => ({
			title: a.data.title,
			description: a.data.description,
			pubDate: a.data.date,
			link: `/articles/${a.id}/`,
		})),
		...films.map((f) => ({
			title: `${f.data.title} (${f.data.year})`,
			description: `Film review, ${f.data.rating}/5.`,
			pubDate: f.data.watchedOn,
			link: `/films/${f.id}/`,
		})),
	].sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());

	return rss({ title: 'Billy', description: 'Writing and film notes.', site: context.site!, items });
}
