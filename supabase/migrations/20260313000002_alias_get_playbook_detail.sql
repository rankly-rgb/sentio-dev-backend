-- Alias: get_playbook_detail → get_playbook_full_detail
-- Le frontend appelle get_playbook_detail, la RPC existante s'appelle get_playbook_full_detail.
-- Cet alias délègue simplement l'appel pour éviter un renommage breaking.

CREATE OR REPLACE FUNCTION public.get_playbook_detail(
  p_playbook_id UUID
)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.get_playbook_full_detail(p_playbook_id);
$$;

GRANT EXECUTE ON FUNCTION public.get_playbook_detail(UUID) TO authenticated;
