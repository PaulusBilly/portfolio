import { getCollection } from 'astro:content';

// Drafts show in `astro dev`, never in the built site.
const published = ({ data }: { data: { draft: boolean } }) => import.meta.env.DEV || !data.draft;

export async function getArticles() {
	const all = await getCollection('articles', published);
	return all.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export async function getFilms() {
	const all = await getCollection('films', published);
	return all.sort((a, b) => b.data.watchedOn.valueOf() - a.data.watchedOn.valueOf());
}

export const formatDate = (date: Date) =>
	date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export const stars = (rating: number) => '★'.repeat(Math.floor(rating)) + (rating % 1 ? '½' : '');
