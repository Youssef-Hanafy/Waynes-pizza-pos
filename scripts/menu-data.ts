/**
 * Wayne's Pizza menu, transcribed from the printed take-out menu
 * (Shamrock Printing, 8/24). Money is in whole cents.
 *
 * This file is a one-time loading source, not a runtime dependency: nothing in
 * the application reads it. `npm run seed:menu` writes these rows into the
 * database, and from that moment Admin -> Menu is the only place the menu is
 * edited. Re-running the seed will not undo an edit made there (see seed-menu.ts).
 */

export type MenuChoice = { name: string; priceDeltaCents?: number };

export type MenuModifierGroup = {
  key: string;
  name: string;
  customerLabel: string;
  required?: boolean;
  minSelect?: number;
  maxSelect?: number;
  /** Lets one choice be taken more than once — two orders of fries on a dinner plate. */
  allowQuantities?: boolean;
  choices: MenuChoice[];
};

export type MenuItem = {
  name: string;
  description?: string;
  /** Used only when the item has no sizes. An item with variants prices from the variant. */
  priceCents?: number;
  variants?: { name: string; priceCents: number }[];
  groups?: string[];
};

export type MenuCategory = { name: string; description?: string; items: MenuItem[] };

const PIZZA_TOPPINGS: MenuChoice[] = [
  { name: "Onions" }, { name: "Peppers" }, { name: "Broccoli" }, { name: "Spinach" },
  { name: "Sliced Tomato" }, { name: "Black Olives" }, { name: "Mushrooms" }, { name: "Eggplant" },
  { name: "Garlic" }, { name: "Anchovies" }, { name: "Jalapeños" }, { name: "Pineapple" },
  { name: "Pepperoni" }, { name: "Salami" }, { name: "Meatball" }, { name: "Sausage" },
  { name: "Ham" }, { name: "Bacon" }, { name: "Hamburger" }, { name: "Feta Cheese" },
];

/**
 * The printed menu prices pizza by tier — one topping, two-way, three-way — rather
 * than per topping, and a topping costs a different amount on a small than on a
 * large. So the tier carries the price and the topping list carries no price: it
 * tells the kitchen what to put on the pizza.
 */
const toppingGroup = (count: number): MenuModifierGroup => ({
  key: `pizza-toppings-${count}`,
  name: `Pizza toppings (${count})`,
  customerLabel: count === 1 ? "Choose your topping" : `Choose ${count} toppings`,
  required: true,
  minSelect: count,
  maxSelect: count,
  choices: PIZZA_TOPPINGS,
});

export const modifierGroups: MenuModifierGroup[] = [
  toppingGroup(1),
  toppingGroup(2),
  toppingGroup(3),
  {
    key: "calzone-toppings",
    name: "Calzone toppings",
    customerLabel: "Choose your toppings",
    minSelect: 0,
    maxSelect: 20,
    choices: PIZZA_TOPPINGS,
  },
  {
    key: "salad-dressing",
    name: "Salad dressing",
    customerLabel: "Choose your dressing",
    required: true,
    minSelect: 1,
    maxSelect: 1,
    choices: [
      { name: "House" }, { name: "Italian" }, { name: "Lite Italian" }, { name: "Ranch" },
      { name: "Bleu Cheese" }, { name: "Peppercorn Parmesan" }, { name: "Oil & Vinegar" },
      { name: "Lemon & Oil" }, { name: "Balsamic Vinaigrette" }, { name: "Thousand Island" },
      { name: "No dressing" },
    ],
  },
  {
    key: "salad-extras",
    name: "Salad extras",
    customerLabel: "Add to your salad",
    minSelect: 0,
    maxSelect: 3,
    choices: [
      { name: "Extra Meat", priceDeltaCents: 450 },
      { name: "Extra Dressing", priceDeltaCents: 160 },
      { name: "Extra Bread", priceDeltaCents: 165 },
    ],
  },
  {
    key: "quesadilla-filling",
    name: "Quesadilla filling",
    customerLabel: "Choose one",
    required: true,
    minSelect: 1,
    maxSelect: 1,
    choices: [{ name: "Steak" }, { name: "Chicken" }, { name: "Veggies" }, { name: "Ham" }, { name: "Salami" }],
  },
  {
    key: "dinner-sides",
    name: "Dinner plate sides",
    customerLabel: "Choose two sides",
    required: true,
    minSelect: 2,
    maxSelect: 2,
    allowQuantities: true,
    choices: [{ name: "French Fries" }, { name: "Onion Rings" }, { name: "Rice Pilaf" }],
  },
  {
    key: "wrap-bread",
    name: "Wrap bread",
    customerLabel: "White or wheat",
    required: true,
    minSelect: 1,
    maxSelect: 1,
    choices: [{ name: "White" }, { name: "Wheat" }],
  },
  {
    key: "cold-sub-requests",
    name: "Cold sub requests",
    customerLabel: "Upon request",
    minSelect: 0,
    maxSelect: 3,
    choices: [{ name: "Pickles" }, { name: "Hot Peppers" }, { name: "No provolone cheese" }],
  },
];

const sizes = (small: number, large: number) => [
  { name: "Small", priceCents: small },
  { name: "Large", priceCents: large },
];
const counts = (smallCount: number, small: number, largeCount: number, large: number) => [
  { name: `${smallCount} pieces`, priceCents: small },
  { name: `${largeCount} pieces`, priceCents: large },
];

export const categories: MenuCategory[] = [
  {
    name: "Pizza",
    description: "Greek & Italian style pizza.",
    items: [
      { name: "Cheese Pizza", variants: sizes(825, 1225) },
      { name: "One-Topping Pizza", variants: sizes(950, 1425), groups: ["pizza-toppings-1"] },
      { name: "Two-Way Combo Pizza", variants: sizes(1025, 1625), groups: ["pizza-toppings-2"] },
      { name: "Three-Way Combo Pizza", variants: sizes(1125, 1800), groups: ["pizza-toppings-3"] },
      { name: "Extra Cheese", description: "Added to any pizza.", variants: sizes(195, 285) },
      { name: "Italian Style 16 In. Cheese Pizza", priceCents: 1375 },
      { name: "Gluten Free Pizza", priceCents: 1400 },
    ],
  },
  {
    name: "Gourmet Pizza",
    items: [
      { name: "Full Combo", description: "Pepperoni, meatball, sausage, ham, mushrooms, onions & peppers", variants: sizes(1300, 2050) },
      { name: "Veggie Combo", description: "Broccoli, spinach, black olives, mushrooms, peppers, onions and sliced tomato", variants: sizes(1300, 2050) },
      { name: "Primavera", description: "Broccoli, spinach, sliced tomato", variants: sizes(1125, 1800) },
      { name: "Greek Pizza", description: "Spinach, feta, sliced tomato", variants: sizes(1150, 1850) },
      { name: "Mexican Pizza", description: "Hamburger, hot sauce, hot banana pepper rings, onions, green peppers, lettuce, sliced tomato", variants: sizes(1200, 1925) },
      { name: "Hawaiian", description: "Ham & pineapple", variants: sizes(1125, 1800) },
      { name: "Meat Lovers", description: "Pepperoni, sausage, ham, bacon, salami", variants: sizes(1300, 2050) },
      { name: "Philly Steak Pizza", description: "Steak, green peppers, onions & mushrooms", variants: sizes(1350, 2075) },
      { name: "White Pizza", description: "Mozzarella, cheddar, feta & parmesan cheese with olive oil", variants: sizes(1150, 1925) },
      { name: "Wayne's Pizza", description: "Eggplant, mushrooms, onions, artichoke hearts, garlic", variants: sizes(1175, 1975) },
      { name: "BBQ Chicken Pizza", variants: sizes(1200, 1975) },
      { name: "Buffalo Chicken Pizza", variants: sizes(1200, 1975) },
      { name: "Chicken, Broccoli & Garlic Pizza", variants: sizes(1325, 2050) },
      { name: "Chicken, Broccoli Alfredo Pizza", variants: sizes(1375, 2075) },
      { name: "Chicken Bacon Ranch Pizza", variants: sizes(1375, 2075) },
      { name: "Five Alarm Pizza", description: "Buffalo chicken, onion, fresh garlic and sliced jalapeños", variants: sizes(1375, 2075) },
      { name: "Alfredo Shrimp Scampi Pizza", variants: sizes(1375, 2075) },
    ],
  },
  {
    name: "Calzones",
    items: [
      { name: "Cheese Calzone", variants: sizes(975, 1400) },
      { name: "Ham & Cheese Calzone", variants: sizes(1025, 1575) },
      { name: "Broccoli & Cheese Calzone", variants: sizes(1025, 1575) },
      { name: "Steak & Cheese Calzone", description: "Green peppers, onions & mushrooms", variants: sizes(1400, 2175) },
      { name: "BBQ Chicken Calzone", variants: sizes(1275, 2000) },
      { name: "Buffalo Chicken Calzone", variants: sizes(1275, 2000) },
      { name: "Chicken Cutlet Calzone", variants: sizes(1275, 2000) },
      { name: "Make Your Own Calzone", description: "Pizza cheese and your toppings", variants: sizes(925, 1325), groups: ["calzone-toppings"] },
    ],
  },
  {
    name: "Appetizers",
    items: [
      { name: "French Fries", variants: sizes(395, 595) },
      { name: "Curly Fries", variants: sizes(450, 625) },
      { name: "Onion Rings", variants: sizes(450, 615) },
      { name: "Cheese Fries", priceCents: 835 },
      { name: "Mozzarella Sticks", variants: counts(7, 725, 14, 1400) },
      { name: "Chicken Fingers", variants: counts(6, 885, 12, 1725) },
      { name: "Buffalo Fingers", variants: counts(6, 910, 12, 1775) },
      { name: "Chicken Wings", variants: counts(10, 1095, 20, 2095) },
      { name: "Buffalo Wings", variants: counts(10, 1195, 20, 2295) },
      { name: "Jalapeño Poppers", variants: counts(8, 885, 16, 1725) },
      { name: "Broccoli Puffs", variants: counts(8, 950, 16, 1825) },
      { name: "Quesadilla", priceCents: 1350, groups: ["quesadilla-filling"] },
      { name: "Fried Mushrooms", priceCents: 875 },
      { name: "Potato Skins", priceCents: 950 },
      { name: "Garlic Bread", priceCents: 425 },
      { name: "Garlic Bread with Cheese", priceCents: 575 },
      { name: "Combo Platter", priceCents: 1495 },
    ],
  },
  {
    name: "Salads",
    description: "Served with Syrian bread & your choice of dressing.",
    items: [
      { name: "Garden Salad", priceCents: 800 },
      { name: "Greek Salad", priceCents: 975 },
      { name: "Antipasto", priceCents: 1000 },
      { name: "Tuna Salad", priceCents: 975 },
      { name: "Seafood Salad", priceCents: 975 },
      { name: "Chicken Salad", priceCents: 1125 },
      { name: "Chef Salad", priceCents: 1100 },
      { name: "Caesar Salad", priceCents: 800 },
      { name: "Turkey Salad", priceCents: 975 },
      { name: "Ham & Provolone Cheese Salad", priceCents: 975 },
      { name: "Grilled Chicken Salad", priceCents: 1225 },
      { name: "Grilled Chicken Caesar Salad", priceCents: 1225 },
      { name: "Steak Tip Salad", priceCents: 1325 },
      { name: "Steak Mediterranean Salad", priceCents: 1525 },
      { name: "Chicken Mediterranean Salad", priceCents: 1375 },
    ].map((item) => ({ ...item, groups: ["salad-dressing", "salad-extras"] })),
  },
  {
    name: "Cold Subs",
    description: "Served with lettuce, tomatoes, onions & provolone cheese. Pickles & hot peppers upon request.",
    items: [
      { name: "Vegetarian", variants: sizes(840, 1035) },
      { name: "Bologna", variants: sizes(840, 1025) },
      { name: "Genoa Salami", variants: sizes(840, 1025) },
      { name: "Ham", variants: sizes(840, 1025) },
      { name: "B.L.T.", variants: sizes(840, 1025) },
      { name: "Italian", variants: sizes(840, 1025) },
      { name: "American", variants: sizes(840, 1025) },
      { name: "Turkey", variants: sizes(865, 1050) },
      { name: "Turkey & Bacon", variants: sizes(995, 1180) },
      { name: "Turkey, Roast Beef & Bacon", variants: sizes(1125, 1295) },
      { name: "Turkey, Ham & Bacon", variants: sizes(1125, 1295) },
      { name: "Roast Beef", variants: sizes(975, 1150) },
      { name: "Tuna", variants: sizes(840, 1025) },
      { name: "Seafood Salad", variants: sizes(860, 1035) },
      { name: "Chicken Salad", variants: sizes(950, 1150) },
    ].map((item) => ({ ...item, groups: ["cold-sub-requests"] })),
  },
  {
    name: "Hot Subs",
    items: [
      { name: "Chicken Parmesan", variants: sizes(920, 1090) },
      { name: "Homemade Meatball", variants: sizes(895, 1075) },
      { name: "Sausage", variants: sizes(895, 1075) },
      { name: "Veal", variants: sizes(920, 1090) },
      { name: "Egg & Cheese", variants: sizes(895, 1075) },
      { name: "Ham, Egg & Cheese", variants: sizes(950, 1125) },
      { name: "Bacon, Egg & Cheese", variants: sizes(975, 1150) },
      { name: "Pepper, Egg & Cheese", variants: sizes(950, 1100) },
      { name: "Steak & Cheese", variants: sizes(920, 1100) },
      { name: "BBQ Steak", variants: sizes(975, 1155) },
      { name: "Steak & Onions", variants: sizes(975, 1155) },
      { name: "Steak & Peppers", variants: sizes(975, 1155) },
      { name: "Steak & Mushrooms", variants: sizes(975, 1155) },
      { name: "Steak Teriyaki", variants: sizes(975, 1155) },
      { name: "Steak Special", description: "Onions, peppers & mushrooms", variants: sizes(1050, 1235) },
      { name: "Steak Bomb", description: "Onions, peppers, mushrooms, salami", variants: sizes(1185, 1365) },
      { name: "Steak Tip", description: "Onions & green peppers", variants: sizes(1235, 1445) },
      { name: "Gyro", priceCents: 1025 },
      { name: "Hot Pastrami", variants: sizes(945, 1115) },
      { name: "Cheeseburger", variants: sizes(895, 1050) },
      { name: "Bacon Cheeseburger", variants: sizes(975, 1210) },
      { name: "Grilled Veggie", description: "Mushrooms, onions, green peppers, broccoli & provolone cheese", variants: sizes(895, 1025) },
    ],
  },
  {
    name: "Chicken Subs",
    items: [
      { name: "Grilled Chicken", variants: sizes(920, 1090) },
      { name: "Chicken Stir-Fry", description: "Marinated fresh chicken, onions, green peppers, mushrooms, broccoli", variants: sizes(975, 1150) },
      { name: "Buffalo Chicken", variants: sizes(975, 1150) },
      { name: "Chicken Club", variants: sizes(1065, 1235) },
      { name: "Grilled Chicken Parmesan", variants: sizes(950, 1125) },
      { name: "Chicken Cordon Bleu", description: "Ham, chicken fingers & provolone cheese", variants: sizes(1095, 1265) },
    ],
  },
  {
    name: "Fat Subs",
    items: [
      { name: "Fat Buffalo Chicken", priceCents: 1470 },
      { name: "Fat Chicken Finger", priceCents: 1470 },
      { name: "Fat Cow Cheeseburger", priceCents: 1470 },
    ],
  },
  {
    name: "Wraps",
    description: "Choice of white or wheat.",
    items: [
      { name: "Caesar Wrap", priceCents: 865 },
      { name: "Chicken Caesar Wrap", priceCents: 1145 },
      { name: "Chicken Mediterranean Wrap", priceCents: 1235 },
      { name: "Mediterranean Steak Tip Wrap", priceCents: 1315 },
    ].map((item) => ({ ...item, groups: ["wrap-bread"] })),
  },
  {
    name: "Dinner Plates",
    description: "Includes your choice of two: French fries, onion rings or rice pilaf.",
    items: [
      { name: "Chicken Finger Dinner", priceCents: 1300, groups: ["dinner-sides"] },
      { name: "Buffalo Chicken Finger Dinner", priceCents: 1375, groups: ["dinner-sides"] },
      { name: "Chicken Wing Dinner", priceCents: 1350, groups: ["dinner-sides"] },
      { name: "Buffalo Chicken Wing Dinner", priceCents: 1450, groups: ["dinner-sides"] },
      { name: "Cheeseburger Dinner", priceCents: 1350, groups: ["dinner-sides"] },
      { name: "Chicken Kabob Dinner", priceCents: 1400, groups: ["dinner-sides"] },
      { name: "Steak Tip Dinner", priceCents: 1675, groups: ["dinner-sides"] },
      { name: "Gyro Dinner", priceCents: 1350, groups: ["dinner-sides"] },
      { name: "Fish & Chips Dinner", description: "Daily", priceCents: 1375, groups: ["dinner-sides"] },
      { name: "Quesadilla Dinner", priceCents: 1675, groups: ["dinner-sides", "quesadilla-filling"] },
      { name: "Shrimp Dinner", description: "Daily", priceCents: 1475, groups: ["dinner-sides"] },
    ],
  },
  {
    name: "Pasta",
    description: "Spaghetti or ziti, served with garlic bread.",
    items: [
      { name: "Pasta with Sauce", priceCents: 850 },
      { name: "Pasta with Meatball", priceCents: 1075 },
      { name: "Pasta with Sausage", priceCents: 1075 },
      { name: "Pasta with Veal", priceCents: 1175 },
      { name: "Pasta with Chicken", priceCents: 1175 },
      { name: "Pasta with Eggplant", priceCents: 1075 },
      { name: "Pasta with Mushrooms", priceCents: 1075 },
      { name: "Chicken, Broccoli & Alfredo", priceCents: 1400 },
      { name: "Manicotti", priceCents: 1200 },
      { name: "Lasagna", priceCents: 1200 },
      { name: "Shrimp Broccoli Alfredo", priceCents: 1550 },
    ],
  },
  {
    name: "Kids Menu",
    items: [
      { name: "Kids Chicken Fingers", priceCents: 850 },
      { name: "Kids Cheeseburger", priceCents: 850 },
      { name: "Kids Pasta", priceCents: 825 },
    ],
  },
  {
    name: "Dessert",
    items: [
      { name: "Baklava", description: "Per piece", priceCents: 395 },
      { name: "Brownie", description: "Per piece", priceCents: 300 },
      { name: "Fried Dough", priceCents: 550 },
    ],
  },
  {
    name: "Beverages",
    items: [
      { name: "2-Liter Bottle", priceCents: 365 },
      { name: "20 oz. Bottle", priceCents: 255 },
    ],
  },
];
