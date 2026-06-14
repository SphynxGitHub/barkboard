interface PetVaccineInfo {
  vaccinationStatus: boolean;
  vaccinationExpiry: string; // ISO String
}

/**
 * Validates if a pet's health records are current for the stay duration
 */
export function isVaccinationValid(pet: PetVaccineInfo, stayEndDateStr: string): boolean {
  if (!pet.vaccinationStatus) return false;
  
  const expiryDate = new Date(pet.vaccinationExpiry);
  const stayEndDate = new Date(stayEndDateStr);
  
  return expiryDate >= stayEndDate;
}
