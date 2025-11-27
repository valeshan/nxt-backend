export const categoryMap: Record<string, string> = {
  '200': 'Sales',
  '300': 'Direct Costs',
  '310': 'Cost of Goods Sold',
  '320': 'Packaging',
  '330': 'Cleaning',
  '340': 'Dairy',
  '350': 'Produce',
  '360': 'Meat',
  '370': 'Beverage',
  '400': 'Advertising',
  '410': 'Consulting',
  '420': 'Entertainment',
  '430': 'Rent',
  '440': 'Utilities',
  '450': 'Wages',
};

export function getCategoryName(accountCode: string | null | undefined): string {
  if (!accountCode) return 'Uncategorized';
  return categoryMap[accountCode] || 'Uncategorized';
}

