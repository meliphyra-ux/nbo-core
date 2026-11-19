export async function getServerSideProps({ query }) {
  return { props: { name: query.name ?? "pages" } };
}

export default function Old({ name }) {
  return <p>pages router says {name}</p>;
}
