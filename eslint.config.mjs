import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...nextVitals,
  {
    ignores: ["node_modules/**", ".next/**", "out/**", "dist/**"],
  },
];

export default config;
