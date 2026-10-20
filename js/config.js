/* AuraFX site configuration. Edit this file to brand the site.
   Everything marked [REQUIRED BEFORE LAUNCH] must be completed and legally reviewed. */
window.AURA_CONFIG = {
  brand: 'AuraFX',
  tagline: 'Learn and practise forex trading in a risk-free simulator',
  /* Business model (spec: choose the model first). "A+DEMO" = education / analytics plus a clearly
     labelled demo simulator. No live execution and no real-money deposits. */
  model: 'A+DEMO',
  legalEntity: '[REQUIRED BEFORE LAUNCH: registered legal entity name]',
  registeredAddress: '[REQUIRED BEFORE LAUNCH: registered address]',
  licenceInfo: '[Only add licence / regulator details if they are accurate and authorised]',
  contactEmail: 'support@example.com',
  supportHours: 'Mon–Fri, 09:00–17:00 UTC',
  responseTime: 'We aim to reply within 2 business days.',
  minAge: 18,
  countries: [['AU','Australia'],['AT','Austria'],['BE','Belgium'],['BR','Brazil'],['CA','Canada'],['DK','Denmark'],['FI','Finland'],['FR','France'],['DE','Germany'],['GH','Ghana'],['IE','Ireland'],['IT','Italy'],['JP','Japan'],['KE','Kenya'],['NL','Netherlands'],['NZ','New Zealand'],['NG','Nigeria'],['NO','Norway'],['PL','Poland'],['PT','Portugal'],['ZA','South Africa'],['ES','Spain'],['SE','Sweden'],['CH','Switzerland'],['AE','United Arab Emirates'],['GB','United Kingdom'],['US','United States'],['IR','Iran'],['KP','North Korea'],['SY','Syria'],['CU','Cuba']],
  restrictedCountries: ['IR','KP','SY','CU'],
  highRiskCountries: ['NG','AE'],
  legal: { terms: '1.0', privacy: '1.0', risk: '1.0', cookies: '1.0', date: '2026-10-19' },
  session: { idleMin: 15, adminIdleMin: 10, absoluteHrs: 8 },
  maxLeverage: 30,
  lot: 100000, minLots: 0.01, maxLots: 10, lotStep: 0.01,
  staleQuoteMs: 5000,
  version: '1.0.0'
};
