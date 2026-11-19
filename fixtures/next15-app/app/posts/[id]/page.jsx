export const dynamic = "force-dynamic";

export default async function Post({ params }) {
  const { id } = await params;
  return <p>post {id}</p>;
}
