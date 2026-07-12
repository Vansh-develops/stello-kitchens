// A small, cuisine-neutral starter menu so a new outlet isn't empty. Prices in INR.
export const STARTER_TEMPLATE: { category: string; items: { name: string; price: number; isVeg: boolean }[] }[] = [
  { category: "Starters", items: [
    { name: "Veg Spring Rolls", price: 160, isVeg: true },
    { name: "Paneer Tikka", price: 220, isVeg: true },
    { name: "Chicken 65", price: 240, isVeg: false },
  ]},
  { category: "Main Course", items: [
    { name: "Paneer Butter Masala", price: 260, isVeg: true },
    { name: "Dal Tadka", price: 180, isVeg: true },
    { name: "Butter Chicken", price: 300, isVeg: false },
  ]},
  { category: "Breads & Rice", items: [
    { name: "Butter Naan", price: 45, isVeg: true },
    { name: "Jeera Rice", price: 140, isVeg: true },
  ]},
  { category: "Beverages", items: [
    { name: "Masala Chai", price: 40, isVeg: true },
    { name: "Fresh Lime Soda", price: 70, isVeg: true },
  ]},
];
