export function GoogleAnalytics() {
  const measurementId = process.env.NEXT_PUBLIC_GA_ID;
  if (!measurementId) return null;

  return (
    <>
      <script async src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`} />
      <script
        id="google-analytics"
        dangerouslySetInnerHTML={{
          __html: `
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${measurementId}', { anonymize_ip: true });
        `,
        }}
      />
    </>
  );
}
