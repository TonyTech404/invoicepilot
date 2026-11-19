function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const env = {
  get databaseUrl() {
    return required('DATABASE_URL');
  },
  get docIntelEndpoint() {
    return required('DOCINTEL_ENDPOINT').replace(/\/$/, '');
  },
  get docIntelKey() {
    return required('DOCINTEL_KEY');
  },
  get openAiEndpoint() {
    return required('AOAI_ENDPOINT').replace(/\/$/, '');
  },
  get openAiKey() {
    return required('AOAI_KEY');
  },
  get openAiDeployment() {
    return process.env.AOAI_DEPLOYMENT ?? 'coder';
  },
  /** Shared with the Cloudflare Worker that serves the custom domain. */
  get proxyKey() {
    return process.env.PROXY_KEY ?? '';
  },
  get cronSecret() {
    return process.env.CRON_SECRET ?? '';
  },
  /** Free-tier guard: Document Intelligence calls allowed per day across all visitors. */
  get dailyExtractLimit() {
    return Number(process.env.DAILY_EXTRACT_LIMIT ?? 60);
  },
  get isProduction() {
    return process.env.NODE_ENV === 'production' || !!process.env.WEBSITE_SITE_NAME;
  },
};
