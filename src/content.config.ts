import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const articles = defineCollection({
	loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/articles' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(),
		tags: z.array(z.string()).default([]),
		draft: z.boolean().default(false),
	}),
});

const films = defineCollection({
	loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/films' }),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			year: z.number().int(),
			director: z.string(),
			rating: z.number().min(0).max(5).multipleOf(0.5),
			watchedOn: z.coerce.date(),
			poster: image().optional(),
			draft: z.boolean().default(false),
		}),
});

export const collections = { articles, films };
