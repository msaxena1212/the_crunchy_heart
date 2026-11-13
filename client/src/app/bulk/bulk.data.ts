/* =========================================================
   BULK & WHOLESALE — shared catalogue data
   Used by the dedicated /bulk page and the home-page teaser.
   Rates are indicative; the final invoice is confirmed on WhatsApp.
   ========================================================= */

export type SutaGrade = '4' | '5' | '6' | '7';
export type BulkQuality = 'normal' | 'handpicked';

export interface SutaGuide {
  grade: SutaGrade;
  name: string;
  shortName: string;
  diameter: string;
  /** Visual diameter in px for the size comparison (scaled to real mm). */
  visualPx: number;
  tag: string;
  badge: string;
  desc: string;
  bestFor: string;
  useCases: string[];
  seedsPerKg: string;
  popRatio: string;
  rates: Record<BulkQuality, number>;
}

export const BULK_MOQ_KG = 100;
export const BULK_WHATSAPP_NUMBER = '919999999999';

export const SUTA_GUIDES: SutaGuide[] = [
  {
    grade: '4',
    name: '4 Suta Micro Popped',
    shortName: '4 Suta',
    diameter: '10 – 12 mm',
    visualPx: 74,
    tag: 'Commercial value',
    badge: 'High yield',
    desc: 'Uniform crisp micro blossoms. The highest kernel count per kilogram, engineered for industrial namkeen, snack mixtures, premixes and extruded bars.',
    bestFor: 'Namkeen, chivda mixtures, premixes and sweet makers',
    useCases: ['Namkeen & mixtures', 'Snack premixes', 'Sweet makers'],
    seedsPerKg: '~18,000 – 22,000 seeds',
    popRatio: '92%+ uniform micro',
    rates: { normal: 720, handpicked: 770 }
  },
  {
    grade: '5',
    name: '5 Suta Classic',
    shortName: '5 Suta',
    diameter: '13 – 15 mm',
    visualPx: 92,
    tag: 'High-yield culinary',
    badge: 'Great value',
    desc: 'Uniform medium-size popped lotus seeds. A high blossom count per kilogram makes it economical for daily roasting, kheer, curries and sweets.',
    bestFor: 'Daily roasting, kheer, curries, namkeen and sweets',
    useCases: ['Daily roasting', 'Kheer & sweets', 'Curries & namkeen'],
    seedsPerKg: '~14,000 – 16,000 seeds',
    popRatio: '95%+',
    rates: { normal: 880, handpicked: 930 }
  },
  {
    grade: '6',
    name: '6 Suta Jumbo Export',
    shortName: '6 Suta',
    diameter: '16 – 18 mm',
    visualPx: 112,
    tag: '★ Most popular',
    badge: '★ Best seller',
    desc: 'The gold standard of Mithila makhana. Export-grade jumbo diameter, cloud-like airy puff, snow-white appearance and zero bitter black kernels.',
    bestFor: 'Gourmet retail packs, luxury gifting hampers and party snacking',
    useCases: ['Retail & D2C packs', 'Gifting hampers', 'Export orders'],
    seedsPerKg: '~10,000 – 12,000 seeds',
    popRatio: '98%+ export grade',
    rates: { normal: 1070, handpicked: 1120 }
  },
  {
    grade: '7',
    name: '7 Suta Royal King',
    shortName: '7 Suta',
    diameter: '20 – 24 mm+',
    visualPx: 140,
    tag: '👑 Royal reserve · top 2% harvest',
    badge: '👑 Royal reserve',
    desc: 'Giant hand-selected king blossoms from the deep wetlands of Darbhanga. The largest makhana grade in India, with breathtaking size and unmatched crispness.',
    bestFor: '5-star hospitality, royal wedding hampers and bespoke export',
    useCases: ['Hotels & hospitality', 'Wedding hampers', 'Bespoke export'],
    seedsPerKg: '~6,500 – 8,000 seeds',
    popRatio: '99% supreme giant',
    rates: { normal: 1280, handpicked: 1330 }
  }
];

export interface QualityInfo {
  key: BulkQuality;
  name: string;
  label: string;
  desc: string;
  points: string[];
}

export const QUALITY_OPTIONS: QualityInfo[] = [
  {
    key: 'normal',
    name: 'Normal Quality',
    label: 'Standard machine graded',
    desc: 'Clean, sieved Mithila wetland harvest with certified moisture levels and uniform crisp puffing.',
    points: ['Machine sieved and graded', 'Certified moisture levels', 'Ideal for processing and daily roasting']
  },
  {
    key: 'handpicked',
    name: 'Handpicked Quality',
    label: '★ Double hand-sorted',
    desc: 'The purest snow-white blossoms, individually hand-inspected after machine grading.',
    points: ['Zero bitter black kernels', 'Zero hard unpopped shells', 'Maximum visual blossom diameter']
  }
];

/** Premium charged for handpicked over normal, per kg (same across sizes today). */
export function handpickedPremium(guide: SutaGuide): number {
  return guide.rates.handpicked - guide.rates.normal;
}
