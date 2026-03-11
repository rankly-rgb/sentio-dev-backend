-- RPC: transition_playbook_status
-- Paramètres:
--   p_playbook_id UUID
--   p_target_status TEXT  -- 'active' | 'draft' | 'archived'
--
-- Transitions autorisées :
--   draft    → active    ✅ (activation)
--   draft    → archived  ✅ (archivage sans activation)
--   active   → draft     ✅ (désactivation / pause)
--   active   → archived  ✅ (archivage)
--   paused   → active    ✅ (reprise)
--   paused   → archived  ✅ (archivage)
--   completed→ archived  ✅ (archivage)
--   archived → *         ❌ INTERDIT (un playbook archivé ne peut pas être réactivé)
--
-- Retourne :
--   { "success": true, "new_status": "active" }
-- ou
--   { "success": false, "error": "Transition non autorisée : archived → active" }

CREATE OR REPLACE FUNCTION public.transition_playbook_status(
  p_playbook_id UUID,
  p_target_status TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
  v_org_id UUID;
  v_allowed_transitions JSONB := '{
    "draft":     ["active", "archived"],
    "active":    ["draft", "archived"],
    "paused":    ["active", "archived"],
    "completed": ["archived"],
    "archived":  []
  }';
BEGIN
  -- Vérification multi-tenant
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Non autorisé : aucun contexte organisation');
  END IF;

  -- Récupérer le statut actuel avec vérification org_id
  SELECT status INTO v_current_status
  FROM public.playbooks
  WHERE id = p_playbook_id
    AND organization_id = v_org_id;

  IF v_current_status IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Playbook non trouvé ou accès refusé');
  END IF;

  -- Valider le statut cible
  IF p_target_status NOT IN ('draft', 'active', 'paused', 'completed', 'archived') THEN
    RETURN json_build_object('success', false, 'error', 'Statut cible invalide : ' || p_target_status);
  END IF;

  -- Vérification de la transition
  IF NOT (v_allowed_transitions->v_current_status @> to_jsonb(p_target_status)) THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Transition non autorisée : ' || v_current_status || ' → ' || p_target_status
    );
  END IF;

  -- Appliquer la transition
  UPDATE public.playbooks
  SET status = p_target_status,
      updated_at = NOW(),
      activated_at = CASE WHEN p_target_status = 'active' AND activated_at IS NULL THEN NOW() ELSE activated_at END,
      deactivated_at = CASE WHEN p_target_status = 'archived' THEN NOW() ELSE deactivated_at END
  WHERE id = p_playbook_id
    AND organization_id = v_org_id;

  RETURN json_build_object('success', true, 'new_status', p_target_status);
END;
$$;

-- Accès pour les utilisateurs authentifiés
GRANT EXECUTE ON FUNCTION public.transition_playbook_status(UUID, TEXT) TO authenticated;
