'use client'

import { createContext, useContext } from 'react'

export interface WizardStep {
  id: string
  label: string
  required: boolean
  status: 'completed' | 'active' | 'pending'
}

export interface OnboardingCtx {
  wizardSteps: WizardStep[]
  currentStep: string
  stripeConnected: boolean
  hubspotConnected: boolean
  firstScoreCalculated: boolean
  ahaMomentSeen: boolean
  onboardingCompleted: boolean
  refresh: () => Promise<void>
}

export const OnboardingContext = createContext<OnboardingCtx | null>(null)

export function useOnboarding() {
  const ctx = useContext(OnboardingContext)
  if (!ctx) throw new Error('useOnboarding must be used inside OnboardingLayout')
  return ctx
}
