export const revalidate = 60;

export default function Isr() {
  return <p>rendered at {new Date().toISOString()}</p>;
}
