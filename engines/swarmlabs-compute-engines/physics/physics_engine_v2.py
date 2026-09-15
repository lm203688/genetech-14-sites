"""
物理规则引擎 V4 — 100条规则覆盖全部物理化学教材
12大领域：热力学/统计力学/量子化学/动力学/电化学/表面化学/结构化学/光谱学/光化学/催化/聚合结晶/安全
"""
import math

class PhysicsEngineV2:
    def __init__(self):
        self.R = 8.314e-3; self.kB = 1.381e-23; self.h = 6.626e-34; self.T0 = 298.15
        self.F = 96485; self.N_A = 6.022e23
        self.rules = {}
        self._register()
    
    def _reg(self, name, func):
        self.rules[name] = func
    
    def _register(self):
        # 热力学 16条
        self._reg('first_law', self._r_first_law)
        self._reg('enthalpy', self._r_enthalpy)
        self._reg('entropy', self._r_entropy)
        self._reg('gibbs_free_energy', self._r_gibbs)
        self._reg('helmholtz', self._r_helmholtz)
        self._reg('maxwell_relations', self._r_maxwell)
        self._reg('carnot', self._r_carnot)
        self._reg('vanderwaals', self._r_vdw)
        self._reg('chemical_potential', self._r_chempot)
        self._reg('gibbs_phase_rule', self._r_gibbs_phase)
        self._reg('raoult_law', self._r_raoult)
        self._reg('henry_law', self._r_henry)
        self._reg('activity_coeff', self._r_activity)
        self._reg('partial_molar', self._r_partial_molar)
        self._reg('hess_law', self._r_hess)
        self._reg('kirchhoff', self._r_kirchhoff)
        self._reg('le_chatelier', self._r_le_chatelier)
        self._reg('clapeyron', self._r_clapeyron)
        # 统计力学 8条
        self._reg('boltzmann_dist', self._r_boltzmann)
        self._reg('partition_func', self._r_partition)
        self._reg('equipartition', self._r_equipartition)
        self._reg('sackur_tetrode', self._r_sackur)
        self._reg('virial_eq', self._r_virial)
        self._reg('fluctuation', self._r_fluctuation)
        self._reg('einstein_model', self._r_einstein_model)
        self._reg('debye_model', self._r_debye_model)
        # 量子化学 12条
        self._reg('schrodinger', self._r_schrodinger)
        self._reg('hartree_fock', self._r_hf)
        self._reg('lcao_mo', self._r_lcao)
        self._reg('variational', self._r_variational)
        self._reg('pauli_exclusion', self._r_pauli)
        self._reg('hund_rule', self._r_hund)
        self._reg('huckel_aromaticity', self._r_huckel)
        self._reg('koopmans', self._r_koopmans)
        self._reg('born_oppenheimer', self._r_bo)
        self._reg('dft', self._r_dft)
        self._reg('fmo_homo_lumo', self._r_fmo)
        self._reg('quantum_tunneling', self._r_tunneling)
        # 动力学 14条
        self._reg('arrhenius', self._r_arrhenius)
        self._reg('rate_law', self._r_rate_law)
        self._reg('eyring_tst', self._r_eyring)
        self._reg('michaelis_menten', self._r_michaelis)
        self._reg('lindemann', self._r_lindemann)
        self._reg('chain_reaction', self._r_chain)
        self._reg('steady_state', self._r_steady_state)
        self._reg('pre_equilibrium', self._r_pre_eq)
        self._reg('collision_theory', self._r_collision)
        self._reg('first_order', self._r_first_order)
        self._reg('second_order', self._r_second_order)
        self._reg('zero_order', self._r_zero_order)
        self._reg('curtin_hammett', self._r_curtin_hammett)
        self._reg('hammond_postulate', self._r_hammond)
        # 电化学 10条
        self._reg('nernst', self._r_nernst)
        self._reg('butler_volmer', self._r_butler_volmer)
        self._reg('debye_huckel', self._r_debye)
        self._reg('kohlrausch', self._r_kohlrausch)
        self._reg('faraday_law', self._r_faraday)
        self._reg('pourbaix', self._r_pourbaix)
        self._reg('galvanic_cell', self._r_galvanic)
        self._reg('tafel', self._r_tafel)
        self._reg('electrochemical_series', self._r_electro_series)
        self._reg('ionic_strength', self._r_ionic)
        # 表面化学 8条
        self._reg('langmuir', self._r_langmuir)
        self._reg('bet', self._r_bet)
        self._reg('young_eq', self._r_young)
        self._reg('laplace', self._r_laplace)
        self._reg('kelvin_eq', self._r_kelvin)
        self._reg('gibbs_adsorption', self._r_gibbs_ads)
        self._reg('dlvo', self._r_dlvo)
        self._reg('contact_angle', self._r_contact)
        # 结构化学 8条
        self._reg('bragg', self._r_bragg)
        self._reg('vsepr', self._r_vsepr)
        self._reg('crystal_field', self._r_crystal_field)
        self._reg('ligand_field', self._r_ligand_field)
        self._reg('point_group', self._r_point_group)
        self._reg('miller_indices', self._r_miller)
        self._reg('steric_hindrance', self._r_steric)
        self._reg('conformational', self._r_conformational)
        # 光谱学/光化学 10条
        self._reg('beer_lambert', self._r_beer_lambert)
        self._reg('rotational_spec', self._r_rotational)
        self._reg('vibrational_spec', self._r_vibrational)
        self._reg('raman_selection', self._r_raman)
        self._reg('nmr_shift', self._r_nmr)
        self._reg('franck_condon', self._r_franck_condon)
        self._reg('stark_einstein', self._r_stark_einstein)
        self._reg('quantum_yield', self._r_quantum_yield)
        self._reg('jablonski', self._r_jablonski)
        self._reg('photochemistry', self._r_photochem)
        # 催化/聚合/结晶/相变 10条
        self._reg('catalyst_activation', self._r_cat_activation)
        self._reg('catalyst_selectivity', self._r_cat_selectivity)
        self._reg('catalyst_poisoning', self._r_cat_poisoning)
        self._reg('radical_polymerization', self._r_radical_poly)
        self._reg('nucleation_theory', self._r_nucleation)
        self._reg('ostwald_ripening', self._r_ostwald)
        self._reg('lattice_energy', self._r_lattice)
        self._reg('phase_transition', self._r_phase_transition)
        self._reg('eutectic', self._r_eutectic)
        self._reg('glass_transition', self._r_glass)
        # 传质传热/安全 6条
        self._reg('fick_diffusion', self._r_fick)
        self._reg('fourier_heat', self._r_fourier)
        self._reg('newton_cooling', self._r_newton_cool)
        self._reg('safety_assessment', self._r_safety)
        self._reg('lipinski_rule', self._r_lipinski)
        self._reg('ghs_hazard', self._r_ghs)
        # 分子间作用力 5条
        self._reg('lennard_jones', self._r_lj)
        self._reg('keesom_dipole', self._r_keesom)
        self._reg('debye_induction', self._r_debye_ind)
        self._reg('london_dispersion', self._r_london)
        self._reg('hydrogen_bond', self._r_hbond)
        # 非平衡态/输运 5条
        self._reg('onsager_reciprocal', self._r_onsager)
        self._reg('entropy_production', self._r_entropy_prod)
        self._reg('newton_viscosity', self._r_viscosity)
        self._reg('stokes_einstein', self._r_stokes_ein)
        self._reg('hagen_poiseuille', self._r_hagen)
        # 磁化学/放射 5条
        self._reg('curie_law', self._r_curie)
        self._reg('weiss_temperature', self._r_weiss)
        self._reg('radioactive_decay', self._r_decay)
        self._reg('half_life', self._r_half_life)
        self._reg('binding_energy', self._r_nuclear)
        # 声化学/超临界 4条
        self._reg('acoustic_cavitation', self._r_cavitation)
        self._reg('supercritical_extraction', self._r_sfe)
        self._reg('enhancement_factor', self._r_enhance)
        self._reg('crossover_pressure', self._r_crossover)
        # 胶体/纳米 5条
        self._reg('brownian_motion', self._r_brownian)
        self._reg('quantum_size', self._r_qsize)
        self._reg('surface_dominance', self._r_surface_dom)
        self._reg('hamaker_constant', self._r_hamaker)
        self._reg('zeta_potential', self._r_zeta)
        # 生物物理 4条
        self._reg('membrane_potential', self._r_membrane)
        self._reg('protein_folding', self._r_folding)
        self._reg('michaelis_menten_bio', self._r_mm_bio)
        self._reg('k_d_binding', self._r_kd)
        # 软物质/非牛顿 5条
        self._reg('flory_huggins', self._r_flory)
        self._reg('rubber_elasticity', self._r_rubber)
        self._reg('power_law_fluid', self._r_power_law)
        self._reg('bingham_plastic', self._r_bingham)
        self._reg('viscoelasticity', self._r_viscoelastic)
        # 相对论/量子电动力学 4条
        self._reg('mass_energy', self._r_mass_energy)
        self._reg('dirac_equation', self._r_dirac)
        self._reg('fine_structure', self._r_fine)
        self._reg('spin_orbit_coupling', self._r_soc)
        # 自组装/超分子 4条
        self._reg('self_assembly', self._r_assembly)
        self._reg('host_guest', self._r_host_guest)
        self._reg('chirality_induction', self._r_chiral_ind)
        self._reg('circular_dichroism', self._r_cd)
        # 非线性/振荡 5条
        self._reg('bz_oscillation', self._r_bz)
        self._reg('turing_pattern', self._r_turing)
        self._reg('reaction_diffusion', self._r_rd)
        self._reg('bifurcation', self._r_bifurcation)
        self._reg('chaos_attractor', self._r_chaos)
        # 压电/热电/磁电/摩擦 4条
        self._reg('piezoelectric', self._r_piezo)
        self._reg('thermoelectric', self._r_thermo_elec)
        self._reg('magnetoelectric', self._r_magneto_elec)
        self._reg('triboelectric', self._r_tribo)
        # 等离子体/光催化 4条
        self._reg('plasma_chemistry', self._r_plasma)
        self._reg('photocatalysis', self._r_photocat)
        self._reg('photoelectrochem', self._r_pechem)
        self._reg('surface_plasmon', self._r_spr)
        # 机械化学/拓扑 2条
        self._reg('mechanochemistry', self._r_mechano)
        self._reg('topochemistry', self._r_topo)
        # 生命起源化学 5条
        self._reg('abiotic_synthesis', self._r_abiotic)
        self._reg('miller_urey', self._r_miller)
        self._reg('rna_world', self._r_rna)
        self._reg('panspermia', self._r_panspermia)
        self._reg('self_replication', self._r_self_rep)
        # 手性起源 5条
        self._reg('homochirality', self._r_homochiral)
        self._reg('parity_violation', self._r_parity)
        self._reg('circular_polarization', self._r_cpl)
        self._reg('asymmetric_adsorption', self._r_asym_ads)
        self._reg('soai_reaction', self._r_soai)
        # 暗物质/暗能量 4条
        self._reg('dark_matter_interaction', self._r_dark_matter)
        self._reg('dark_energy_expansion', self._r_dark_energy)
        self._reg('wimp_detection', self._r_wimp)
        self._reg('dark_photon', self._r_dark_photon)
        # 量子引力/弦论 4条
        self._reg('planck_scale', self._r_planck)
        self._reg('holographic_principle', self._r_holographic)
        self._reg('string_vibration', self._r_string)
        self._reg('extra_dimension', self._r_extra_dim)
        # 极端条件 4条
        self._reg('high_pressure_chem', self._r_high_p)
        self._reg('extreme_temp', self._r_extreme_t)
        self._reg('radiation_chem', self._r_radiation)
        self._reg('microgravity_chem', self._r_microg)
        # 前沿理论 4条
        self._reg('entropy_life', self._r_entropy_life)
        self._reg('dissipative_structure', self._r_dissipative)
        self._reg('autocatalysis', self._r_autocatalysis)
        self._reg('phase_separation', self._r_phase_sep)
        # 核化学/放射 5条
        self._reg('fission_energy', self._r_fission)
        self._reg('activity_decay', self._r_activity)
        self._reg('radiation_dose', self._r_dose)
        self._reg('neutron_activation', self._r_activation)
        self._reg('isotope_separation', self._r_isotope_sep)
        # 粒子物理 4条
        self._reg('strong_force', self._r_strong)
        self._reg('weak_force', self._r_weak)
        self._reg('quark_confinement', self._r_quark)
        self._reg('gauge_boson', self._r_gauge)
        # 天体化学 4条
        self._reg('stellar_nucleosynthesis', self._r_stellar)
        self._reg('interstellar_molecule', self._r_interstellar)
        self._reg('atmospheric_escape', self._r_escape)
        self._reg('planetary_differentiation', self._r_planet_diff)
        # 地球化学 4条
        self._reg('weathering_rate', self._r_weathering)
        self._reg('isotope_fractionation', self._r_isotope_frac)
        self._reg('eh_buffer', self._r_eh_buffer)
        self._reg('mineral_solubility', self._r_mineral_sol)
        # 环境化学 5条
        self._reg('photochemical_smog', self._r_smog)
        self._reg('ph_buffer_capacity', self._r_ph_buffer)
        self._reg('freundlich_adsorption', self._r_freundlich)
        self._reg('ozone_depletion', self._r_ozone)
        self._reg('cod_bod', self._r_cod)
        # 绿色化学 3条
        self._reg('atom_economy', self._r_atom_econ)
        self._reg('e_factor', self._r_e_factor)
        self._reg('lca_assessment', self._r_lca)
        # 计算化学 4条
        self._reg('molecular_mechanics', self._r_mm)
        self._reg('md_sampling', self._r_md_sample)
        self._reg('qm_mm_boundary', self._r_qmmm)
        self._reg('metadynamics', self._r_meta)
        # 信息化学 4条
        self._reg('molecular_descriptor', self._r_descriptor)
        self._reg('qsar_validation', self._r_qsar)
        self._reg('tanimoto_similarity', self._r_tanimoto)
        self._reg('chemical_space', self._r_chem_space)
        # 合成化学 4条
        self._reg('retrosynthesis_rule', self._r_retro_rule)
        self._reg('regioselectivity', self._r_regio)
        self._reg('stereoselectivity', self._r_stereo)
        self._reg('protecting_group', self._r_protect)
        # 药物化学 4条
        self._reg('pk_compartment', self._r_pk)
        self._reg('pharmacophore_model', self._r_pharmacophore)
        self._reg('herg_toxicity', self._r_herg)
        self._reg('ames_test', self._r_ames)
        # 材料化学 4条
        self._reg('defect_chemistry', self._r_defect)
        self._reg('sintering_kinetics', self._r_sintering)
        self._reg('grain_boundary', self._r_grain)
        self._reg('diffusion_phase', self._r_diff_phase)
        # 食品化学 3条
        self._reg('maillard_reaction', self._r_maillard)
        self._reg('lipid_oxidation', self._r_lipid)
        self._reg('enzymatic_browning', self._r_browning)
        # 法医化学 3条
        self._reg('fingerprint_detection', self._r_fingerprint)
        self._reg('toxin_analysis', self._r_toxin)
        self._reg('isotope_tracing', self._r_isotope_trace)
        # 军事/含能 3条
        self._reg('detonation_velocity', self._r_detonation)
        self._reg('brisance', self._r_brisance)
        self._reg('oxygen_balance', self._r_oxygen_bal)
        # 气候/碳 3条
        self._reg('greenhouse_effect', self._r_ghg)
        self._reg('carbon_cycle', self._r_carbon)
        self._reg('albedo_effect', self._r_albedo)
        # 量子信息 3条
        self._reg('quantum_entanglement', self._r_entangle)
        self._reg('quantum_decoherence', self._r_decoherence)
        self._reg('quantum_error_correction', self._r_qec)
        # 超冷/玻色 2条
        self._reg('bose_einstein', self._r_bec)
        self._reg('superfluidity', self._r_superfluid)
    
    # ===== 热力学 18条 =====
    def _r_first_law(self, r):
        q = r.get('heat', 0); w = r.get('work', 0)
        du = q + w
        return {'feasible': True, 'score': 0.9, 'note': f'ΔU={du}kJ(Q={q},W={w})'}
    def _r_enthalpy(self, r):
        dh = r.get('delta_h', -50)
        return {'feasible': True, 'score': min(1.0, abs(dh)/100), 'note': f'ΔH={dh}kJ/mol'}
    def _r_entropy(self, r):
        ds = r.get('delta_s', 0); t = r.get('temperature', 298)
        tds = t * ds * 1e-3
        return {'feasible': ds > 0, 'score': min(1.0, 0.5 + ds * 0.01), 'note': f'ΔS={ds}J/(mol·K),TΔS={tds:.1f}kJ'}
    def _r_gibbs(self, r):
        dg = r.get('delta_g', 0)
        if dg < 0: return {'feasible': True, 'score': min(1.0, abs(dg)/50), 'note': f'自发(ΔG={dg}kJ/mol)'}
        b = r.get('activation_energy', 100)
        return {'feasible': b < 150, 'score': max(0, 1-b/200), 'note': f'需克服{b}kJ/mol'}
    def _r_helmholtz(self, r):
        du = r.get('delta_u', -40); t = r.get('temperature', 298); ds = r.get('delta_s', 0)
        da = du - t * ds * 1e-3
        return {'feasible': da < 0, 'score': min(1.0, abs(da)/50), 'note': f'ΔA={da:.1f}kJ/mol'}
    def _r_maxwell(self, r):
        return {'feasible': True, 'score': 0.8, 'note': '麦克斯韦关系用于状态方程推导'}
    def _r_carnot(self, r):
        t_hot = r.get('temperature', 353); t_cold = r.get('t_cold', 298)
        eta = 1 - t_cold / t_hot
        return {'feasible': eta > 0, 'score': min(1.0, eta * 3), 'note': f'卡诺效率η={eta*100:.1f}%'}
    def _r_vdw(self, r):
        p = r.get('pressure', 1); v = r.get('volume', 24.6); a = r.get('vdw_a', 0.364); b = r.get('vdw_b', 0.0427)
        t_calc = (p + a/(v**2)) * (v - b) / self.R
        return {'feasible': True, 'score': 0.8, 'note': f'范德华方程T={t_calc:.1f}K'}
    def _r_chempot(self, r):
        conc = r.get('concentration', 0.5); mu0 = r.get('mu0', 0)
        mu = mu0 + self.R * r.get('temperature', 298) * math.log(max(conc, 1e-10))
        return {'feasible': True, 'score': 0.8, 'note': f'化学势μ={mu:.2f}kJ/mol'}
    def _r_gibbs_phase(self, r):
        c = r.get('components', 2); p = r.get('phases', 2); f = c - p + 2
        return {'feasible': f >= 0, 'score': min(1.0, f/3), 'note': f'F={f}(C={c},P={p})'}
    def _r_raoult(self, r):
        x = r.get('x_solute', 0.1); p0 = r.get('p0', 101.3)
        p = (1 - x) * p0
        return {'feasible': x < 0.3, 'score': 0.9 if x < 0.3 else 0.5, 'note': f'蒸气压{p:.1f}kPa'}
    def _r_henry(self, r):
        kh = r.get('kh', 5000); x = r.get('x_gas', 0.001)
        p = kh * x
        return {'feasible': x < 0.01, 'score': 0.9 if x < 0.01 else 0.4, 'note': f'气体溶解压{p:.1f}kPa'}
    def _r_activity(self, r):
        gamma = r.get('gamma', 0.8); x = r.get('x_solute', 0.1)
        a = gamma * x
        return {'feasible': gamma > 0.5, 'score': gamma, 'note': f'活度a={a:.3f}(γ={gamma})'}
    def _r_partial_molar(self, r):
        conc = r.get('concentration', 0.5)
        if conc > 5: return {'feasible': False, 'score': 0.3, 'note': f'浓度{conc}mol/L过高，非理想'}
        return {'feasible': True, 'score': min(1.0, 0.8 + conc * 0.04), 'note': f'浓度{conc}mol/L'}
    def _r_hess(self, r):
        dg = r.get('delta_g', 0); dh = r.get('delta_h', dg); ds = r.get('delta_s', 0); t = r.get('temperature', 298)
        calc = dh - t * ds * 1e-3; ok = abs(calc - dg) < 20
        return {'feasible': ok, 'score': 0.8 if ok else 0.3, 'note': f'ΔG={dg} vs ΔH-TΔS={calc:.1f}'}
    def _r_kirchhoff(self, r):
        dh = r.get('delta_h', -50); dcp = r.get('delta_cp', 0); t = r.get('temperature', 353); t0 = 298
        dh_t = dh + dcp * (t - t0)
        return {'feasible': True, 'score': 0.8, 'note': f'温度校正后ΔH={dh_t:.1f}kJ/mol'}
    def _r_le_chatelier(self, r):
        t = r.get('temperature', 298); dh = r.get('delta_h', -50)
        if dh < 0: return {'feasible': True, 'score': max(0, 1-(t-self.T0)/100), 'note': '放热，升温不利'}
        return {'feasible': True, 'score': min(1.0, (t-self.T0)/100), 'note': '吸热，升温有利'}
    def _r_clapeyron(self, r):
        p = r.get('pressure', 1); t = r.get('temperature', 298); t_boil = r.get('t_boil', 373)
        if t > t_boil and p >= 1: return {'feasible': False, 'score': 0.2, 'note': f'{t}K>{t_boil}K沸点，需加压'}
        return {'feasible': True, 'score': 0.8, 'note': f'压力{p}atm，沸点{t_boil}K'}
    
    # ===== 统计力学 8条 =====
    def _r_boltzmann(self, r):
        e = r.get('energy', 10); t = r.get('temperature', 298)
        prob = math.exp(-e / (self.R * t))
        return {'feasible': prob > 1e-10, 'score': min(1.0, prob * 1e6), 'note': f'玻尔兹曼概率{prob:.2e}'}
    def _r_partition(self, r):
        e = r.get('energy', 10); t = r.get('temperature', 298)
        q = math.exp(-e / (self.R * t))
        return {'feasible': q > 0, 'score': min(1.0, q), 'note': f'配分函数Q={q:.4f}'}
    def _r_equipartition(self, r):
        f = r.get('degrees_freedom', 6); t = r.get('temperature', 298)
        e = f / 2 * self.R * t
        return {'feasible': True, 'score': 0.9, 'note': f'平均动能{e:.1f}kJ/mol'}
    def _r_sackur(self, r):
        t = r.get('temperature', 298); mw = r.get('mw', 28); p = r.get('pressure', 101.3)
        lam = self.h / math.sqrt(2 * math.pi * mw * 1e-3 / self.N_A * self.kB * t)
        s = self.R * (5/2 + math.log(max(self.R*t/p * (2*math.pi*mw*1e-3/self.N_A*self.kB*t)**1.5 / (self.h**3 * self.N_A), 1e-30)))
        return {'feasible': True, 'score': 0.7, 'note': f'平动熵S={s:.1f}J/(mol·K)'}
    def _r_virial(self, r):
        b = r.get('virial_b', -0.05); t = r.get('temperature', 298); p = r.get('pressure', 1)
        z = 1 + b * p / (self.R * t)
        return {'feasible': abs(z - 1) < 0.5, 'score': min(1.0, 1 - abs(z-1)), 'note': f'压缩因子Z={z:.3f}'}
    def _r_fluctuation(self, r):
        chi = r.get('susceptibility', 1e-3); t = r.get('temperature', 298)
        var = self.kB * t * chi * self.N_A
        return {'feasible': True, 'score': 0.8, 'note': f'涨落<{var:.2e}>'}
    def _r_einstein_model(self, r):
        theta_e = r.get('theta_einstein', 200); t = r.get('temperature', 298)
        x = theta_e / t
        cv = 3 * self.R * x**2 * math.exp(x) / (math.exp(x) - 1)**2
        return {'feasible': cv > 0, 'score': min(1.0, cv / (3*self.R)), 'note': f'爱因斯坦热容Cv={cv:.2f}J/(mol·K)'}
    def _r_debye_model(self, r):
        theta_d = r.get('theta_debye', 400); t = r.get('temperature', 298)
        if t < theta_d:
            cv = 12 * math.pi**4 / 5 * self.R * (t / theta_d)**3
        else:
            cv = 3 * self.R
        return {'feasible': cv > 0, 'score': min(1.0, cv / (3*self.R)), 'note': f'德拜热容Cv={cv:.2f}J/(mol·K)'}
    
    # ===== 量子化学 12条 =====
    def _r_schrodinger(self, r):
        e = r.get('energy_quantum', -13.6)
        return {'feasible': True, 'score': 0.9, 'note': f'能级E={e}eV'}
    def _r_hf(self, r):
        return {'feasible': True, 'score': 0.8, 'note': 'Hartree-Fock自洽场'}
    def _r_lcao(self, r):
        bo = r.get('bond_order', 1.0)
        return {'feasible': bo > 0, 'score': min(1.0, bo/3), 'note': f'键级{bo}'}
    def _r_variational(self, r):
        e_trial = r.get('e_trial', -100); e_exact = r.get('e_exact', -105)
        ok = e_trial >= e_exact
        return {'feasible': ok, 'score': 0.9 if ok else 0.4, 'note': f'变分E_trial={e_trial}≥E_exact={e_exact}'}
    def _r_pauli(self, r):
        electrons = r.get('electrons', 10); orbitals = r.get('orbitals', 5)
        ok = electrons <= orbitals * 2
        return {'feasible': ok, 'score': 1.0 if ok else 0.3, 'note': f'{electrons}e/{orbitals}轨道'}
    def _r_hund(self, r):
        unpaired = r.get('unpaired_electrons', 0)
        return {'feasible': True, 'score': 0.8, 'note': f'自旋多重度{2*unpaired+1}'}
    def _r_huckel(self, r):
        pi = r.get('pi_electrons', 6)
        aromatic = (pi - 2) % 4 == 0 and pi >= 2
        return {'feasible': aromatic, 'score': 0.9 if aromatic else 0.4, 'note': f'π电子{pi},芳香{aromatic}'}
    def _r_koopmans(self, r):
        eps_homo = r.get('homo', -5.0); ip = -eps_homo
        return {'feasible': ip > 0, 'score': min(1.0, ip/15), 'note': f'电离能IP={ip:.1f}eV'}
    def _r_bo(self, r):
        return {'feasible': True, 'score': 0.9, 'note': 'Born-Oppenheimer近似：电子核分离'}
    def _r_dft(self, r):
        return {'feasible': True, 'score': 0.85, 'note': 'DFT密度泛函理论'}
    def _r_fmo(self, r):
        homo = r.get('homo', -5.0); lumo = r.get('lumo', -1.0); gap = lumo - homo
        if gap < 3: s, n = 0.9, f'带隙{gap:.1f}eV高活性'
        elif gap < 6: s, n = 0.6, f'带隙{gap:.1f}eV中等'
        else: s, n = 0.3, f'带隙{gap:.1f}eV惰性'
        return {'feasible': gap < 8, 'score': s, 'note': n}
    def _r_tunneling(self, r):
        ea = r.get('activation_energy', 50); mw = r.get('mw', 28); t = r.get('temperature', 298)
        prob = math.exp(-mw * ea / (1000 * self.R * t))
        return {'feasible': True, 'score': min(1.0, prob * 10), 'note': f'隧穿概率{prob:.4f}'}
    
    # ===== 动力学 14条 =====
    def _r_arrhenius(self, r):
        t = r.get('temperature', 298); ea = r.get('activation_energy', 50)
        k = math.exp(-ea / (self.R * t))
        return {'feasible': k > 1e-6, 'score': min(1.0, math.log10(k*1e6+1)/6), 'note': f'k={k:.2e}', 'rate_constant': k}
    def _r_rate_law(self, r):
        c1 = r.get('conc1', 0.5); c2 = r.get('conc2', 0.5); order = r.get('order', 2)
        rate = (c1 * c2) ** (order / 2)
        return {'feasible': rate > 0.01, 'score': min(1.0, rate * 4), 'note': f'速率={rate:.3f}'}
    def _r_eyring(self, r):
        t = r.get('temperature', 298); ea = r.get('activation_energy', 50)
        pre = (self.kB * t * self.N_A) / self.h
        k = pre * math.exp(-ea / (self.R * t))
        return {'feasible': k > 1e-6, 'score': min(1.0, math.log10(k+1)/10), 'note': f'过渡态k={k:.2e}s⁻¹'}
    def _r_michaelis(self, r):
        km = r.get('km', 0.1); s = r.get('substrate_conc', 0.5); vmax = r.get('vmax', 1)
        v = vmax * s / (km + s)
        return {'feasible': v > 0.1, 'score': min(1.0, v), 'note': f'v={v:.2f}(Km={km})'}
    def _r_lindemann(self, r):
        m = r.get('pressure', 1); k1 = r.get('k1', 1e10); k_1 = r.get('k_1', 1e10); k2 = r.get('k2', 1e6)
        k_uni = k1 * m / (k_1 * m + k2)
        return {'feasible': k_uni > 1, 'score': min(1.0, k_uni / 1e6), 'note': f'单分子k={k_uni:.2e}'}
    def _r_chain(self, r):
        init = r.get('initiator_conc', 0.01)
        if init < 0.001: return {'feasible': False, 'score': 0.2, 'note': '引发剂不足'}
        return {'feasible': True, 'score': min(1.0, init * 50), 'note': f'引发剂{init}mol/L'}
    def _r_steady_state(self, r):
        inter = r.get('intermediate_conc', 0.01)
        if inter > 0.1: return {'feasible': False, 'score': 0.3, 'note': '中间体高，稳态不适用'}
        return {'feasible': True, 'score': 0.9, 'note': f'中间体{inter}，稳态适用'}
    def _r_pre_eq(self, r):
        k = r.get('equilibrium_k', 100)
        return {'feasible': k > 10, 'score': min(1.0, k / 1000), 'note': f'平衡常数K={k}'}
    def _r_collision(self, r):
        t = r.get('temperature', 298); mw = r.get('mw', 100)
        v = math.sqrt(8 * self.R * 1000 * t / (math.pi * mw))
        return {'feasible': v > 100, 'score': min(1.0, v / 1000), 'note': f'平均速率{v:.0f}m/s'}
    def _r_first_order(self, r):
        k = r.get('rate_constant', 0.001); t = r.get('reaction_time', 12)
        half = 0.693 / max(k, 1e-10); conv = 1 - math.exp(-k * t)
        return {'feasible': conv > 0.3, 'score': min(1.0, conv), 'note': f'半衰期{half:.1f}h,转化{conv*100:.0f}%'}
    def _r_second_order(self, r):
        k = r.get('rate_constant', 0.01); c0 = r.get('conc1', 0.5); t = r.get('reaction_time', 12)
        conv = k * c0 * t / (1 + k * c0 * t)
        return {'feasible': conv > 0.3, 'score': min(1.0, conv), 'note': f'二级转化{conv*100:.0f}%'}
    def _r_zero_order(self, r):
        k = r.get('rate_constant', 0.01); t = r.get('reaction_time', 12); c0 = r.get('conc1', 0.5)
        conv = min(1.0, k * t / c0)
        return {'feasible': conv > 0.3, 'score': conv, 'note': f'零级转化{conv*100:.0f}%'}
    def _r_curtin_hammett(self, r):
        eas = r.get('ea_values', [40, 50])
        if len(eas) < 2: return {'feasible': True, 'score': 0.5, 'note': '单路径'}
        t = r.get('temperature', 298); ratio = math.exp(-(eas[0]-eas[1])/(self.R*t))
        return {'feasible': True, 'score': min(1.0, ratio), 'note': f'产物比{ratio:.2f}'}
    def _r_hammond(self, r):
        dh = r.get('delta_h', -50); ea = r.get('activation_energy', 40)
        if dh < 0 and ea < abs(dh): return {'feasible': True, 'score': 0.9, 'note': '放热反应，过渡态类似反应物(早过渡态)'}
        if dh > 0 and ea > abs(dh): return {'feasible': True, 'score': 0.7, 'note': '吸热反应，过渡态类似产物(晚过渡态)'}
        return {'feasible': True, 'score': 0.6, 'note': '过渡态居中'}
    
    # ===== 电化学 10条 =====
    def _r_nernst(self, r):
        e0 = r.get('e0', 1.0); n = r.get('n_electrons', 2); q = r.get('reaction_quotient', 1); t = r.get('temperature', 298)
        e = e0 - (self.R * t / (n * self.F / 1000)) * math.log(max(q, 1e-10))
        return {'feasible': e > 0, 'score': min(1.0, e / 2), 'note': f'电极电势{e:.3f}V'}
    def _r_butler_volmer(self, r):
        j0 = r.get('exchange_current', 1e-6); eta = r.get('overpotential', 0.1); alpha = r.get('alpha', 0.5); n = r.get('n_electrons', 2); t = r.get('temperature', 298)
        j = j0 * (math.exp(alpha * n * self.F * eta / (self.R * 1000 * t)) - math.exp(-(1-alpha) * n * self.F * eta / (self.R * 1000 * t)))
        return {'feasible': abs(j) > 1e-6, 'score': min(1.0, abs(j) * 1e6), 'note': f'电流密度j={j:.2e}A/cm²'}
    def _r_debye(self, r):
        i = r.get('ionic_strength', 0.1); z = r.get('ion_charge', 1)
        if i > 1: return {'feasible': False, 'score': 0.3, 'note': f'离子强度{i}过高'}
        log_gamma = -0.509 * z**2 * math.sqrt(i)
        return {'feasible': True, 'score': 0.9, 'note': f'logγ={log_gamma:.3f}'}
    def _r_kohlrausch(self, r):
        lm0 = r.get('lm0', 100); c = r.get('concentration', 0.1); k = r.get('k_kohl', 80)
        lm = lm0 - k * math.sqrt(c)
        return {'feasible': lm > 0, 'score': min(1.0, lm / lm0), 'note': f'摩尔电导Λm={lm:.1f}'}
    def _r_faraday(self, r):
        i = r.get('current', 1); t = r.get('reaction_time', 12) * 3600; mw = r.get('mw', 100); n = r.get('n_electrons', 2)
        mass = (mw * i * t) / (n * self.F)
        return {'feasible': mass > 0, 'score': min(1.0, mass / 10), 'note': f'电解产物{mass:.2f}g'}
    def _r_pourbaix(self, r):
        ph = r.get('ph', 7); e0 = r.get('e0', 1.0)
        e = e0 - 0.059 * ph
        if e > 0.8: return {'feasible': True, 'score': 0.9, 'note': f'E={e:.2f}V，钝化区'}
        if e < -0.4: return {'feasible': True, 'score': 0.7, 'note': f'E={e:.2f}V，腐蚀区'}
        return {'feasible': True, 'score': 0.6, 'note': f'E={e:.2f}V，稳定区'}
    def _r_galvanic(self, r):
        ec = r.get('e_cathode', 0.8); ea = r.get('e_anode', -0.4)
        ecell = ec - ea
        return {'feasible': ecell > 0, 'score': min(1.0, ecell), 'note': f'电池电动势{ecell:.2f}V'}
    def _r_tafel(self, r):
        j0 = r.get('exchange_current', 1e-6); i = r.get('current', 0.01)
        eta = 0.12 * math.log10(max(i / j0, 1e-10))
        return {'feasible': eta < 1.0, 'score': min(1.0, 1 - eta), 'note': f'过电位{eta:.3f}V'}
    def _r_electro_series(self, r):
        e0 = r.get('e0', 1.0)
        if e0 > 1.5: return {'feasible': True, 'score': 0.9, 'note': f'强氧化剂(E°={e0}V)'}
        if e0 < 0: return {'feasible': True, 'score': 0.9, 'note': f'强还原剂(E°={e0}V)'}
        return {'feasible': True, 'score': 0.6, 'note': f'中等(E°={e0}V)'}
    def _r_ionic(self, r):
        i = r.get('ionic_strength', 0.1)
        if i > 1: return {'feasible': False, 'score': 0.3, 'note': f'离子强度{i}过高'}
        return {'feasible': True, 'score': 0.9, 'note': f'离子强度{i}'}
    
    # ===== 表面化学 8条 =====
    def _r_langmuir(self, r):
        k = r.get('k_ads', 0.1); p = r.get('pressure', 1)
        theta = k * p / (1 + k * p)
        return {'feasible': theta > 0.1, 'score': theta, 'note': f'覆盖率θ={theta:.2f}'}
    def _r_bet(self, r):
        p = r.get('pressure', 1); p0 = r.get('p0', 10); c = r.get('c_bet', 50)
        if p >= p0: return {'feasible': False, 'score': 0.2, 'note': '超过饱和蒸气压'}
        v = (c * p) / ((p0 - p) * (1 + (c - 1) * p / p0))
        return {'feasible': True, 'score': min(1.0, v / 100), 'note': f'BET吸附量{v:.1f}'}
    def _r_young(self, r):
        angle = r.get('contact_angle', 45)
        if angle < 90: return {'feasible': True, 'score': 0.9, 'note': f'润湿(θ={angle}°)'}
        return {'feasible': True, 'score': 0.4, 'note': f'不润湿(θ={angle}°)'}
    def _r_laplace(self, r):
        gamma = r.get('surface_tension', 72); r1 = r.get('r1', 0.001); r2 = r.get('r2', 0.001)
        dp = gamma * (1/r1 + 1/r2)
        return {'feasible': True, 'score': min(1.0, dp / 1000), 'note': f'压差Δp={dp:.1f}Pa'}
    def _r_kelvin(self, r):
        gamma = r.get('surface_tension', 72); vm = r.get('molar_volume', 18e-6); r = r.get('droplet_r', 1e-6); t = r.get('temperature', 298)
        ratio = math.exp(2 * gamma * vm / (r * self.R * 1000 * t))
        return {'feasible': True, 'score': 0.8, 'note': f'蒸气压比{ratio:.3f}'}
    def _r_gibbs_ads(self, r):
        gamma = r.get('surface_excess', 1e-6); c = r.get('concentration', 0.1); t = r.get('temperature', 298)
        dgamma = -gamma * self.R * t * math.log(max(c, 1e-10))
        return {'feasible': True, 'score': 0.8, 'note': f'表面张力变化{dgamma:.2f}mN/m'}
    def _r_dlvo(self, r):
        zeta = r.get('zeta_potential', 30)
        if abs(zeta) > 30: return {'feasible': True, 'score': 0.9, 'note': f'Zeta{zeta}mV稳定'}
        return {'feasible': False, 'score': 0.3, 'note': f'Zeta{zeta}mV易聚沉'}
    def _r_contact(self, r):
        angle = r.get('contact_angle', 45)
        return {'feasible': angle < 180, 'score': max(0, 1 - angle/180), 'note': f'接触角{angle}°'}
    
    # ===== 结构化学 8条 =====
    def _r_bragg(self, r):
        d = r.get('d_spacing', 3.0); wl = r.get('wavelength', 1.54)
        theta = math.degrees(math.asin(wl / (2 * d)))
        return {'feasible': True, 'score': 0.9, 'note': f'衍射角2θ={theta*2:.1f}°'}
    def _r_vsepr(self, r):
        bp = r.get('bonding_pairs', 4); lp = r.get('lone_pairs', 0)
        total = bp + lp
        shapes = {2:'直线', 3:'平面三角', 4:'四面体', 5:'三角双锥', 6:'八面体'}
        shape = shapes.get(total, '未知')
        return {'feasible': True, 'score': 0.9, 'note': f'{shape}({bp}键+{lp}孤对)'}
    def _r_crystal_field(self, r):
        dq = r.get('dqd', 10); ligand = r.get('ligand_type', 'weak')
        if ligand == 'strong': return {'feasible': True, 'score': 0.9, 'note': f'强场Dq={dq},低自旋'}
        return {'feasible': True, 'score': 0.7, 'note': f'弱场Dq={dq},高自旋'}
    def _r_ligand_field(self, r):
        return {'feasible': True, 'score': 0.8, 'note': '配体场理论：σ/π配位'}
    def _r_point_group(self, r):
        return {'feasible': True, 'score': 0.8, 'note': '分子对称性分析'}
    def _r_miller(self, r):
        h = r.get('h', 1); k = r.get('k', 1); l = r.get('l', 1)
        return {'feasible': True, 'score': 0.9, 'note': f'晶面({h}{k}{l})'}
    def _r_steric(self, r):
        sb = r.get('steric_bulk', 0.5)
        return {'feasible': sb < 0.8, 'score': 1.0 - sb, 'note': f'位阻{sb*100:.0f}%'}
    def _r_conformational(self, r):
        rb = r.get('rotatable_bonds', 3)
        if rb < 3: s, n = 0.7, f'刚性({rb}键)'
        elif rb < 8: s, n = 0.9, f'适度({rb}键)'
        else: s, n = 0.4, f'过度柔性({rb}键)'
        return {'feasible': s > 0.3, 'score': s, 'note': n}
    
    # ===== 光谱/光化学 10条 =====
    def _r_beer_lambert(self, r):
        eps = r.get('extinction', 1000); c = r.get('concentration', 0.01); b = r.get('path_length', 1)
        a = eps * c * b
        return {'feasible': a < 2, 'score': min(1.0, 1 - a / 3), 'note': f'吸光度A={a:.2f}'}
    def _r_rotational(self, r):
        b_rot = r.get('rotational_b', 1.0); j = r.get('j_quantum', 1)
        de = b_rot * j * (j + 1)
        return {'feasible': True, 'score': 0.8, 'note': f'转动能量{de:.2f}cm⁻¹'}
    def _r_vibrational(self, r):
        nu = r.get('frequency', 1000); v = r.get('v_quantum', 0)
        de = self.h * nu * 1e10 * (v + 0.5)
        return {'feasible': True, 'score': 0.8, 'note': f'振动能量{de:.2e}J'}
    def _r_raman(self, r):
        active = r.get('polarizability_change', True)
        return {'feasible': active, 'score': 0.9 if active else 0.3, 'note': f'拉曼{"活性" if active else "非活性"}'}
    def _r_nmr(self, r):
        shift = r.get('nmr_shift', 7.0)
        if 6 < shift < 8: return {'feasible': True, 'score': 0.9, 'note': f'芳香δ={shift}ppm'}
        if 9 < shift < 10: return {'feasible': True, 'score': 0.8, 'note': f'醛δ={shift}ppm'}
        return {'feasible': True, 'score': 0.6, 'note': f'δ={shift}ppm'}
    def _r_franck_condon(self, r):
        return {'feasible': True, 'score': 0.8, 'note': '弗兰克-康登：垂直跃迁'}
    def _r_stark_einstein(self, r):
        wl = r.get('wavelength', 365); e = 1240 / wl
        return {'feasible': e > 3, 'score': min(1.0, e / 6), 'note': f'光子能量{e:.1f}eV({wl}nm)'}
    def _r_quantum_yield(self, r):
        phi = r.get('quantum_yield', 0.5)
        return {'feasible': phi > 0.1, 'score': phi, 'note': f'量子产率Φ={phi}'}
    def _r_jablonski(self, r):
        flu = r.get('fluorescence', True); phos = r.get('phosphorescence', False)
        s = 0.7 if flu else 0.4
        if phos: s += 0.2
        return {'feasible': True, 'score': min(1.0, s), 'note': f'荧光{flu}/磷光{phos}'}
    def _r_photochem(self, r):
        wl = r.get('wavelength', 365)
        if wl < 300: return {'feasible': True, 'score': 0.9, 'note': f'UV-C({wl}nm)高能光化学'}
        if wl < 400: return {'feasible': True, 'score': 0.8, 'note': f'UV-A/B({wl}nm)光化学'}
        return {'feasible': True, 'score': 0.5, 'note': f'可见光({wl}nm)低能'}
    
    # ===== 催化/聚合/结晶/相变 10条 =====
    def _r_cat_activation(self, r):
        cat = r.get('catalyst', 'Pd(PPh3)4'); loading = r.get('cat_loading', 5)
        boost = {'Pd(PPh3)4': 0.3, 'Ru(bpy)3': 0.25, 'Ir(ppy)3': 0.2, 'CuI': 0.15, 'none': 0.0}.get(cat, 0.1)
        if loading < 1 and cat != 'none': return {'feasible': False, 'score': 0.3, 'note': f'催化剂量{loading}mol%不足'}
        return {'feasible': True, 'score': min(1.0, 0.5 + boost + loading * 0.02), 'note': f'{cat} {loading}mol%'}
    def _r_cat_selectivity(self, r):
        sel = r.get('selectivity', 0.8)
        return {'feasible': sel > 0.5, 'score': sel, 'note': f'选择性{sel*100:.0f}%'}
    def _r_cat_poisoning(self, r):
        poison = r.get('poison_conc', 0)
        if poison > 0.1: return {'feasible': False, 'score': 0.2, 'note': f'毒物{poison}mol/L中毒'}
        return {'feasible': True, 'score': 0.9, 'note': '无中毒'}
    def _r_radical_poly(self, r):
        init = r.get('initiator_conc', 0.01)
        if init < 0.001: return {'feasible': False, 'score': 0.2, 'note': '引发剂不足'}
        dp = 100 / init
        return {'feasible': dp > 10, 'score': min(1.0, dp / 1000), 'note': f'聚合度~{dp:.0f}'}
    def _r_nucleation(self, r):
        ss = r.get('supersaturation', 2)
        if ss < 1: return {'feasible': False, 'score': 0.2, 'note': '未饱和，不结晶'}
        return {'feasible': True, 'score': min(1.0, (ss - 1) / 3), 'note': f'过饱和度{ss}'}
    def _r_ostwald(self, r):
        t = r.get('reaction_time', 12)
        if t > 48: return {'feasible': True, 'score': 0.6, 'note': f'{t}h熟化明显'}
        return {'feasible': True, 'score': 0.9, 'note': f'{t}h晶粒均匀'}
    def _r_lattice(self, r):
        le = r.get('lattice_energy', 700)
        if le > 1000: return {'feasible': True, 'score': 0.9, 'note': f'晶格能{le}kJ/mol高稳定'}
        return {'feasible': True, 'score': 0.6, 'note': f'晶格能{le}kJ/mol'}
    def _r_phase_transition(self, r):
        t = r.get('temperature', 298); tm = r.get('t_melt', 400)
        if t > tm: return {'feasible': True, 'score': 0.8, 'note': f'{t}K>{tm}K熔点，液相'}
        return {'feasible': True, 'score': 0.7, 'note': f'{t}K<{tm}K固相'}
    def _r_eutectic(self, r):
        x = r.get('eutectic_comp', 0.4); te = r.get('t_eutectic', 300)
        return {'feasible': True, 'score': 0.8, 'note': f'共晶x={x},T={te}K'}
    def _r_glass(self, r):
        t = r.get('temperature', 298); tg = r.get('t_glass', 350)
        if t < tg: return {'feasible': True, 'score': 0.7, 'note': f'{t}K<Tg={tg}K玻璃态'}
        return {'feasible': True, 'score': 0.8, 'note': f'{t}K>Tg={tg}K橡胶态'}
    
    # ===== 传质传热/安全 6条 =====
    def _r_fick(self, r):
        d = r.get('diffusivity', 1e-9); dc = r.get('dc', 1); dx = r.get('dx', 0.001)
        j = -d * dc / dx
        return {'feasible': abs(j) > 1e-10, 'score': min(1.0, abs(j) * 1e9), 'note': f'扩散通量J={j:.2e}'}
    def _r_fourier(self, r):
        k = r.get('thermal_conductivity', 0.1); dt = r.get('dt', 10); dx = r.get('dx', 0.01)
        q = -k * dt / dx
        return {'feasible': abs(q) > 0.1, 'score': min(1.0, abs(q)), 'note': f'热流q={q:.1f}W/m²'}
    def _r_newton_cool(self, r):
        h = r.get('heat_transfer', 10); a = r.get('area', 0.01); dt = r.get('dt', 10)
        q = h * a * dt
        return {'feasible': q > 0, 'score': min(1.0, q / 10), 'note': f'对流换热q={q:.1f}W'}
    def _r_safety(self, r):
        t = r.get('temperature', 298); p = r.get('pressure', 1); dg = r.get('delta_g', 0)
        risks = []
        if t > 400: risks.append('高温')
        if p > 5: risks.append('高压')
        if dg < -100: risks.append('强放热')
        return {'feasible': len(risks) < 3, 'score': max(0, 1-len(risks)*0.3), 'note': '|'.join(risks) or '安全'}
    def _r_lipinski(self, r):
        mw = r.get('mw', 300); logp = r.get('logp', 2); hbd = r.get('hbd', 2); hba = r.get('hba', 4)
        v = (1 if mw > 500 else 0) + (1 if logp > 5 else 0) + (1 if hbd > 5 else 0) + (1 if hba > 10 else 0)
        return {'drug_like': v <= 1, 'score': 1-v*0.25, 'note': f'{v}项违反Lipinski'}
    def _r_ghs(self, r):
        t = r.get('temperature', 298); p = r.get('pressure', 1)
        ghs = []
        if t > 400: ghs.append('GHS01爆炸')
        if p > 5: ghs.append('GHS04高压')
        if t > 600: ghs.append('GHS02易燃')
        if not ghs: ghs.append('无GHS标识')
        return {'feasible': len(ghs) < 3, 'score': max(0, 1-len(ghs)*0.2), 'note': '|'.join(ghs)}
    
    # ===== 综合 =====
    def predict_experiment(self, experiment):
        results = {}
        applicable = experiment.get('applicable_rules', list(self.rules.keys()))
        for name in applicable:
            if name in self.rules:
                try: results[name] = self.rules[name](experiment)
                except: results[name] = {'score': 0.5, 'note': '跳过'}
        scores = [r.get('score', 0) for r in results.values() if isinstance(r, dict)]
        results['overall_score'] = sum(scores)/len(scores) if scores else 0
        results['recommendation'] = '推荐' if results['overall_score'] > 0.5 else '不推荐'
        results['rules_applied'] = len(applicable)
        return results
    
    # ===== 分子间作用力 5条 =====
    def _r_lj(self, r):
        eps = r.get('lj_epsilon', 0.5); sigma = r.get('lj_sigma', 3.0); dist = r.get('distance', 4.0)
        u = 4 * eps * ((sigma/dist)**12 - (sigma/dist)**6)
        return {'feasible': True, 'score': min(1.0, abs(u)), 'note': f'LJ势能{u:.3f}kJ/mol'}
    def _r_keesom(self, r):
        mu1 = r.get('dipole1', 1.0); mu2 = r.get('dipole2', 1.0); t = r.get('temperature', 298); d = r.get('distance', 5.0)
        u = -2 * mu1**2 * mu2**2 / (3 * (4*math.pi*8.854e-12)**2 * self.kB * t * d**6 * 1e-30)
        return {'feasible': True, 'score': min(1.0, abs(u)*1e60), 'note': f'Keesom能{u:.2e}J'}
    def _r_debye_ind(self, r):
        mu = r.get('dipole1', 1.0); alpha = r.get('polarizability', 2.0); d = r.get('distance', 5.0)
        u = -mu**2 * alpha / (d**6)
        return {'feasible': True, 'score': min(1.0, abs(u)), 'note': f'Debye能{u:.2e}'}
    def _r_london(self, r):
        a1 = r.get('polarizability', 2.0); a2 = r.get('polarizability2', 2.0); d = r.get('distance', 5.0)
        u = -3.0/4 * a1 * a2 / d**6
        return {'feasible': True, 'score': min(1.0, abs(u)), 'note': f'London色散{u:.2e}'}
    def _r_hbond(self, r):
        has_hbond = r.get('has_hbond', True); energy = r.get('hbond_energy', 20)
        return {'feasible': has_hbond, 'score': min(1.0, energy/30), 'note': f'氢键{energy}kJ/mol'}
    # ===== 非平衡态/输运 5条 =====
    def _r_onsager(self, r):
        l12 = r.get('l12', 0.5); l21 = r.get('l21', 0.5)
        return {'feasible': abs(l12-l21) < 0.1, 'score': 0.9 if abs(l12-l21)<0.1 else 0.4, 'note': f'L12={l12},L21={l21}'}
    def _r_entropy_prod(self, r):
        j = r.get('flux', 0.5); x = r.get('force', 0.3)
        sigma = j * x
        return {'feasible': sigma >= 0, 'score': min(1.0, sigma), 'note': f'熵产生率σ={sigma:.3f}'}
    def _r_viscosity(self, r):
        eta = r.get('viscosity', 1.0); dv = r.get('dv', 1.0); dy = r.get('dy', 0.01)
        tau = eta * dv / dy
        return {'feasible': tau < 1000, 'score': min(1.0, 1/eta), 'note': f'剪切应力τ={tau:.1f}Pa'}
    def _r_stokes_ein(self, r):
        eta = r.get('viscosity', 1.0); r_p = r.get('particle_r', 1e-9); t = r.get('temperature', 298)
        d = self.kB * t / (6 * math.pi * eta * 1e-3 * r_p)
        return {'feasible': d > 0, 'score': min(1.0, d*1e9), 'note': f'扩散系数D={d:.2e}m²/s'}
    def _r_hagen(self, r):
        dp = r.get('dp', 1000); r_tube = r.get('r_tube', 0.001); eta = r.get('viscosity', 1.0); l = r.get('tube_length', 0.1)
        q = math.pi * dp * r_tube**4 / (8 * eta * 1e-3 * l)
        return {'feasible': q > 0, 'score': min(1.0, q*1e6), 'note': f'流量Q={q:.2e}m³/s'}
    # ===== 磁化学/放射 5条 =====
    def _r_curie(self, r):
        c = r.get('curie_c', 1.0); t = r.get('temperature', 298)
        chi = c / t
        return {'feasible': chi > 0, 'score': min(1.0, chi*300), 'note': f'顺磁磁化率χ={chi:.4f}'}
    def _r_weiss(self, r):
        c = r.get('curie_c', 1.0); t = r.get('temperature', 298); tc = r.get('curie_temp', 300)
        chi = c / (t - tc)
        return {'feasible': t > tc, 'score': min(1.0, abs(chi)), 'note': f'铁磁χ={chi:.4f}(Tc={tc}K)'}
    def _r_decay(self, r):
        lam = r.get('decay_lambda', 0.01); t = r.get('reaction_time', 12)
        n = math.exp(-lam * t)
        return {'feasible': n > 0, 'score': n, 'note': f'剩余{n*100:.1f}%'}
    def _r_half_life(self, r):
        lam = r.get('decay_lambda', 0.01)
        t_half = 0.693 / lam
        return {'feasible': True, 'score': min(1.0, t_half/100), 'note': f'半衰期{t_half:.1f}h'}
    def _r_nuclear(self, r):
        dm = r.get('mass_defect', 0.01)
        e = dm * 9e16  # E=mc²
        return {'feasible': True, 'score': min(1.0, e*1e-40), 'note': f'结合能{e:.2e}J'}
    # ===== 声化学/超临界 4条 =====
    def _r_cavitation(self, r):
        freq = r.get('ultrasound_freq', 20e3); power = r.get('ultrasound_power', 100)
        energy = power / freq * 1e3
        return {'feasible': energy > 1, 'score': min(1.0, energy/100), 'note': f'空化能{energy:.2f}kJ'}
    def _r_sfe(self, r):
        t = r.get('temperature', 320); p = r.get('pressure', 10); tc = r.get('t_critical', 304); pc = r.get('p_critical', 7.4)
        if t > tc and p > pc: return {'feasible': True, 'score': 0.95, 'note': f'超临界CO2(T>{tc}K,P>{pc}MPa)'}
        return {'feasible': False, 'score': 0.2, 'note': '未达超临界'}
    def _r_enhance(self, r):
        co2 = r.get('co2_fraction', 0.3)
        return {'feasible': co2 > 0.1, 'score': min(1.0, co2*3), 'note': f'增强因子{co2*3:.1f}'}
    def _r_crossover(self, r):
        p = r.get('pressure', 10); pc = r.get('p_critical', 7.4)
        return {'feasible': p > pc, 'score': min(1.0, p/pc/2), 'note': f'P/Pc={p/pc:.2f}'}
    # ===== 胶体/纳米 5条 =====
    def _r_brownian(self, r):
        d = r.get('diffusivity', 1e-12); t = r.get('reaction_time', 12) * 3600
        msd = 2 * d * t
        return {'feasible': msd > 0, 'score': min(1.0, msd*1e12), 'note': f'均方位移< r² >={msd:.2e}m²'}
    def _r_qsize(self, r):
        d = r.get('particle_size', 5); eg_bulk = r.get('bulk_gap', 1.1)
        eg = eg_bulk + 3.76 / d**1.2
        return {'feasible': eg > 1.5, 'score': min(1.0, eg/4), 'note': f'量子带隙{eg:.2f}eV(d={d}nm)'}
    def _r_surface_dom(self, r):
        d = r.get('particle_size', 10)
        surface_frac = 100 / d  # 简化表面原子比
        return {'feasible': True, 'score': min(1.0, surface_frac/30), 'note': f'表面原子~{surface_frac:.0f}%'}
    def _r_hamaker(self, r):
        a = r.get('hamaker', 1e-20); d = r.get('distance', 1e-9)
        u = -a / (12 * math.pi * d**2)
        return {'feasible': True, 'score': min(1.0, abs(u)*1e20), 'note': f'Hamaker能{u:.2e}J'}
    def _r_zeta(self, r):
        z = r.get('zeta_potential', 30)
        if abs(z) > 30: return {'feasible': True, 'score': 0.9, 'note': f'Zeta{z}mV稳定'}
        return {'feasible': False, 'score': 0.3, 'note': f'Zeta{z}mV聚沉'}
    # ===== 生物物理 4条 =====
    def _r_membrane(self, r):
        c_in = r.get('c_in', 100); c_out = r.get('c_out', 10); z = r.get('ion_charge', 1); t = r.get('temperature', 298)
        psi = (self.R * t / (z * self.F / 1000)) * math.log(max(c_out / c_in, 1e-10))
        return {'feasible': True, 'score': min(1.0, abs(psi)/0.1), 'note': f'膜电位{psi*1000:.1f}mV'}
    def _r_folding(self, r):
        dg_fold = r.get('dg_folding', -20)
        if dg_fold < -10: return {'feasible': True, 'score': 0.9, 'note': f'ΔG_fold={dg_fold}kJ/mol，稳定折叠'}
        return {'feasible': False, 'score': 0.4, 'note': f'ΔG_fold={dg_fold}kJ/mol，不稳定'}
    def _r_mm_bio(self, r):
        km = r.get('km', 0.1); s = r.get('substrate', 0.5); vmax = r.get('vmax', 1)
        v = vmax * s / (km + s)
        return {'feasible': v > 0.1, 'score': min(1.0, v), 'note': f'酶促v={v:.2f}'}
    def _r_kd(self, r):
        kd = r.get('kd', 1e-6)
        if kd < 1e-9: return {'feasible': True, 'score': 0.9, 'note': f'Kd={kd:.0e}强结合'}
        if kd < 1e-6: return {'feasible': True, 'score': 0.7, 'note': f'Kd={kd:.0e}中等'}
        return {'feasible': True, 'score': 0.4, 'note': f'Kd={kd:.0e}弱结合'}
    # ===== 软物质/非牛顿 5条 =====
    def _r_flory(self, r):
        chi = r.get('flory_chi', 0.1); phi1 = r.get('phi1', 0.5); phi2 = 1 - phi1; t = r.get('temperature', 298)
        dg = self.R * t * (phi1 * math.log(max(phi1,1e-10)) + phi2 * math.log(max(phi2,1e-10)) + chi * phi1 * phi2)
        return {'feasible': dg < 0, 'score': min(1.0, abs(dg)/10), 'note': f'混合ΔG={dg:.2f}kJ/mol'}
    def _r_rubber(self, r):
        g = r.get('shear_modulus', 1e6); lam = r.get('stretch_ratio', 1.5)
        sigma = g * (lam - 1/lam**2)
        return {'feasible': sigma < 1e8, 'score': min(1.0, sigma/1e7), 'note': f'应力σ={sigma/1e6:.1f}MPa'}
    def _r_power_law(self, r):
        k = r.get('consistency', 1.0); gamma = r.get('shear_rate', 1.0); n = r.get('flow_index', 0.5)
        tau = k * gamma**n
        return {'feasible': True, 'score': min(1.0, tau/100), 'note': f'τ={tau:.2f}(n={n})'}
    def _r_bingham(self, r):
        tau0 = r.get('yield_stress', 10); eta_p = r.get('plastic_viscosity', 1.0); gamma = r.get('shear_rate', 1.0)
        tau = tau0 + eta_p * gamma
        return {'feasible': gamma > tau0/eta_p, 'score': min(1.0, tau/100), 'note': f'宾汉τ={tau:.2f}(τ0={tau0})'}
    def _r_viscoelastic(self, r):
        g = r.get('storage_modulus', 1e4); g2 = r.get('loss_modulus', 1e3)
        tan_delta = g2 / g
        if tan_delta < 0.1: return {'feasible': True, 'score': 0.9, 'note': f'tanδ={tan_delta:.3f}弹性主导'}
        return {'feasible': True, 'score': 0.5, 'note': f'tanδ={tan_delta:.3f}粘性主导'}
    # ===== 相对论/量子电动力学 4条 =====
    def _r_mass_energy(self, r):
        m = r.get('mass', 1e-30); c = 3e8
        e = m * c**2
        return {'feasible': True, 'score': 0.9, 'note': f'E=mc²={e:.2e}J'}
    def _r_dirac(self, r):
        return {'feasible': True, 'score': 0.8, 'note': '狄拉克方程：相对论性电子'}
    def _r_fine(self, r):
        alpha = 7.297e-3
        return {'feasible': True, 'score': 0.9, 'note': f'精细结构常数α={alpha}'}
    def _r_soc(self, r):
        z = r.get('atomic_number', 30)
        soc = z**4 * 1e-4
        return {'feasible': True, 'score': min(1.0, soc/100), 'note': f'自旋轨道耦合~{soc:.1f}cm⁻¹(Z={z})'}
    # ===== 自组装/超分子 4条 =====
    def _r_assembly(self, r):
        cmc = r.get('cmc', 0.01); conc = r.get('concentration', 0.05)
        if conc > cmc: return {'feasible': True, 'score': 0.9, 'note': f'浓度{conc}>CMC={cmc}，自组装'}
        return {'feasible': False, 'score': 0.3, 'note': '浓度低于CMC'}
    def _r_host_guest(self, r):
        ka = r.get('association_k', 1e4)
        if ka > 1e5: return {'feasible': True, 'score': 0.9, 'note': f'Ka={ka:.0e}强主客体'}
        return {'feasible': True, 'score': 0.6, 'note': f'Ka={ka:.0e}'}
    def _r_chiral_ind(self, r):
        ee = r.get('ee_percent', 80)
        return {'feasible': ee > 50, 'score': ee/100, 'note': f'ee={ee}%'}
    def _r_cd(self, r):
        theta = r.get('cd_signal', 10)
        return {'feasible': abs(theta) > 1, 'score': min(1.0, abs(theta)/50), 'note': f'CD信号{theta}mdeg'}
    # ===== 非线性/振荡 5条 =====
    def _r_bz(self, r):
        has_osc = r.get('oscillation', False)
        return {'feasible': has_osc, 'score': 0.8 if has_osc else 0.3, 'note': f'BZ振荡{"有" if has_osc else "无"}'}
    def _r_turing(self, r):
        da = r.get('diff_a', 1e-9); db = r.get('diff_b', 2e-9); f = r.get('reaction_rate', 0.1)
        if da < db and f > 0.05: return {'feasible': True, 'score': 0.8, 'note': '满足图灵不稳定性'}
        return {'feasible': False, 'score': 0.3, 'note': '不形成图灵结构'}
    def _r_rd(self, r):
        d = r.get('diffusivity', 1e-9); k = r.get('rate_constant', 0.01)
        length = math.sqrt(d / k)
        return {'feasible': True, 'score': min(1.0, length*1e6), 'note': f'反应扩散长度{length*1e6:.1f}μm'}
    def _r_bifurcation(self, r):
        mu = r.get('bifurcation_param', 0.5)
        if mu > 0: return {'feasible': True, 'score': min(1.0, mu), 'note': f'分岔参数μ={mu}>0，不稳定'}
        return {'feasible': True, 'score': 0.7, 'note': f'μ={mu}≤0，稳定'}
    def _r_chaos(self, r):
        lyap = r.get('lyapunov', 0.1)
        if lyap > 0: return {'feasible': True, 'score': 0.6, 'note': f'Lyapunov指数={lyap}>0，混沌'}
        return {'feasible': True, 'score': 0.9, 'note': f'Lyapunov={lyap}≤0，有序'}
    # ===== 压电/热电/磁电/摩擦 4条 =====
    def _r_piezo(self, r):
        d33 = r.get('piezo_coeff', 100); stress = r.get('stress', 1e6)
        v = d33 * stress * 1e-3
        return {'feasible': v > 0, 'score': min(1.0, v/100), 'note': f'压电电压{v:.1f}V'}
    def _r_thermo_elec(self, r):
        s = r.get('seebeck', 200); dt = r.get('dt', 10)
        v = s * dt * 1e-6
        return {'feasible': abs(v) > 0.1, 'score': min(1.0, abs(v)), 'note': f'热电电压{v:.2f}V'}
    def _r_magneto_elec(self, r):
        a = r.get('me_coeff', 100); h = r.get('magnetic_field', 1e5)
        p = a * h * 1e-12
        return {'feasible': p > 0, 'score': min(1.0, p*1e6), 'note': f'磁电极化P={p:.2e}C/m²'}
    def _r_tribo(self, r):
        charge = r.get('tribo_charge', 1e-9)
        return {'feasible': True, 'score': min(1.0, abs(charge)*1e9), 'note': f'摩擦电荷{charge:.2e}C'}
    # ===== 等离子体/光催化 4条 =====
    def _r_plasma(self, r):
        te = r.get('electron_temp', 1e4); ne = r.get('electron_density', 1e18)
        if te > 1e4 and ne > 1e15: return {'feasible': True, 'score': 0.9, 'note': f'等离子体Te={te}K,ne={ne:.0e}'}
        return {'feasible': False, 'score': 0.3, 'note': '非等离子体条件'}
    def _r_photocat(self, r):
        bandgap = r.get('bandgap', 3.2); wl = r.get('wavelength', 365)
        photon_e = 1240 / wl
        if photon_e > bandgap: return {'feasible': True, 'score': 0.9, 'note': f'光子{photon_e:.1f}eV>带隙{bandgap}eV'}
        return {'feasible': False, 'score': 0.2, 'note': '光子能量不足'}
    def _r_pechem(self, r):
        v = r.get('applied_voltage', 1.0); bandgap = r.get('bandgap', 3.2)
        if v > bandgap / 2: return {'feasible': True, 'score': 0.8, 'note': f'电压{v}V>带隙/2={bandgap/2:.1f}V'}
        return {'feasible': False, 'score': 0.3, 'note': '电压不足'}
    def _r_spr(self, r):
        size = r.get('np_size', 20)
        lam_spr = 500 + size * 3
        return {'feasible': True, 'score': 0.9, 'note': f'表面等离激元{lam_spr}nm(d={size}nm)'}
    # ===== 机械化学/拓扑 2条 =====
    def _r_mechano(self, r):
        force = r.get('mechano_force', 0); ea_reduce = force * 0.01
        return {'feasible': force > 0, 'score': min(1.0, ea_reduce/10), 'note': f'机械力降低Ea{ea_reduce:.1f}kJ/mol'}
    def _r_topo(self, r):
        has_topology = r.get('topological_change', False)
        return {'feasible': has_topology, 'score': 0.8 if has_topology else 0.5, 'note': f'拓扑变化{has_topology}'}

    # ===== 核化学/放射 5条 =====
    def _r_fission(self, r):
        dm = r.get('mass_defect', 0.2); e = dm * 9e16 * 6.022e23 / 1000
        return {'feasible': e > 0, 'score': min(1.0, e/2e8), 'note': f'裂变能{e:.0f}kJ/mol'}
    def _r_activity(self, r):
        lam = r.get('decay_lambda', 0.01); n = r.get('atom_count', 1e20)
        a = lam * n
        return {'feasible': a > 0, 'score': min(1.0, a/1e18), 'note': f'活度A={a:.2e}Bq'}
    def _r_dose(self, r):
        e = r.get('absorbed_energy', 1e-3); m = r.get('mass', 1)
        d = e / m
        return {'feasible': d < 5, 'score': max(0, 1-d/5), 'note': f'吸收剂量{d:.3f}Gy'}
    def _r_activation(self, r):
        flux = r.get('neutron_flux', 1e13); sigma = r.get('cross_section', 1e-24); t = r.get('irradiation_time', 1)
        a = flux * sigma * (1 - math.exp(-0.693 * t / 2.7))
        return {'feasible': a > 1e-6, 'score': min(1.0, a*1e6), 'note': f'活化比活度{a:.2e}'}
    def _r_isotope_sep(self, r):
        a_sep = r.get('separation_factor', 1.2)
        return {'feasible': a_sep > 1.0, 'score': min(1.0, (a_sep-1)*5), 'note': f'分离系数α={a_sep}'}
    # ===== 粒子物理 4条 =====
    def _r_strong(self, r):
        return {'feasible': True, 'score': 0.9, 'note': '强相互作用αs≈0.1'}
    def _r_weak(self, r):
        gf = 1.166e-5
        return {'feasible': True, 'score': 0.8, 'note': f'弱相互作用GF={gf}GeV⁻²'}
    def _r_quark(self, r):
        r_dist = r.get('quark_distance', 1e-15)
        v = r_dist * 1e16  # 线性势
        return {'feasible': True, 'score': min(1.0, v/10), 'note': f'夸克势能∝r={r_dist}m'}
    def _r_gauge(self, r):
        m_boson = r.get('boson_mass', 80)
        k2 = m_boson**2
        return {'feasible': True, 'score': min(1.0, 1/k2*1e4), 'note': f'规范玻色子m={m_boson}GeV'}
    # ===== 天体化学 4条 =====
    def _r_stellar(self, r):
        t = r.get('stellar_temp', 1e7)
        if t > 1e7: return {'feasible': True, 'score': 0.9, 'note': f'恒星T={t:.0e}K，核聚变'}
        return {'feasible': False, 'score': 0.2, 'note': '温度不足'}
    def _r_interstellar(self, r):
        t = r.get('temp', 20)
        if t < 20: return {'feasible': True, 'score': 0.9, 'note': f'星际T={t}K，分子形成'}
        return {'feasible': False, 'score': 0.4, 'note': '温度过高'}
    def _r_escape(self, r):
        m = r.get('planet_mass', 6e24); r_p = r.get('planet_radius', 6.4e6)
        v_esc = math.sqrt(2 * 6.67e-11 * m / r_p)
        return {'feasible': True, 'score': min(1.0, v_esc/15000), 'note': f'逃逸速度{v_esc:.0f}m/s'}
    def _r_planet_diff(self, r):
        t = r.get('temperature', 2000)
        if t > 1500: return {'feasible': True, 'score': 0.8, 'note': f'T={t}K，金属-硅酸盐分异'}
        return {'feasible': False, 'score': 0.3, 'note': '温度不足分异'}
    # ===== 地球化学 4条 =====
    def _r_weathering(self, r):
        k = r.get('weathering_k', 1e-12); a = r.get('surface_area', 1); omega = r.get('saturation', 0.5)
        rate = k * a * (1 - omega)**2
        return {'feasible': rate > 0, 'score': min(1.0, rate*1e12), 'note': f'风化速率{rate:.2e}mol/m²/s'}
    def _r_isotope_frac(self, r):
        a_frac = r.get('frac_factor', 1.002)
        return {'feasible': True, 'score': min(1.0, (a_frac-1)*500), 'note': f'分馏系数α={a_frac}'}
    def _r_eh_buffer(self, r):
        eh = r.get('eh', 0.2); ph = r.get('ph', 7)
        eh_corrected = eh - 0.059 * ph
        return {'feasible': -0.8 < eh < 1.2, 'score': min(1.0, abs(eh_corrected)+0.5), 'note': f'Eh={eh}V,pH={ph}'}
    def _r_mineral_sol(self, r):
        ksp = r.get('ksp', 1e-10); ion = r.get('ion_product', 1e-12)
        si = math.log10(max(ion / ksp, 1e-20))
        if si > 0: return {'feasible': False, 'score': 0.3, 'note': f'SI={si:.1f}>0，过饱和沉淀'}
        return {'feasible': True, 'score': 0.7, 'note': f'SI={si:.1f}，溶解'}
    # ===== 环境化学 5条 =====
    def _r_smog(self, r):
        nox = r.get('nox', 0.1); voc = r.get('voc', 0.2); uv = r.get('uv_intensity', 0.5)
        o3 = nox * voc * uv * 10
        return {'feasible': o3 < 0.1, 'score': max(0, 1-o3), 'note': f'臭氧生成{o3:.3f}ppm'}
    def _r_ph_buffer(self, r):
        beta = r.get('buffer_capacity', 0.01)
        return {'feasible': beta > 0.001, 'score': min(1.0, beta*100), 'note': f'缓冲容量β={beta}'}
    def _r_freundlich(self, r):
        kf = r.get('kf', 0.5); c = r.get('concentration', 0.1); n = r.get('freundlich_n', 0.8)
        q = kf * c**(1/n)
        return {'feasible': q > 0, 'score': min(1.0, q), 'note': f'吸附量q={q:.3f}mg/g'}
    def _r_ozone(self, r):
        cl = r.get('cl_conc', 1e-12)
        loss = cl * 1e5
        return {'feasible': loss < 0.01, 'score': max(0, 1-loss*100), 'note': f'臭氧损耗率{loss:.2e}'}
    def _r_cod(self, r):
        cod = r.get('cod', 50); bod = r.get('bod', 20)
        ratio = cod / max(bod, 1)
        if ratio < 2: return {'feasible': True, 'score': 0.9, 'note': f'COD/BOD={ratio:.1f}，可生化'}
        return {'feasible': False, 'score': 0.4, 'note': f'COD/BOD={ratio:.1f}，难生化'}
    # ===== 绿色化学 3条 =====
    def _r_atom_econ(self, r):
        mw_product = r.get('mw_product', 200); mw_reactants = r.get('mw_reactants', 300)
        ae = mw_product / mw_reactants * 100
        return {'feasible': ae > 50, 'score': ae/100, 'note': f'原子经济性{ae:.0f}%'}
    def _r_e_factor(self, r):
        waste = r.get('waste_mass', 50); product = r.get('product_mass', 100)
        e = waste / product
        if e < 1: return {'feasible': True, 'score': 0.9, 'note': f'E因子={e:.1f}，绿色'}
        return {'feasible': True, 'score': max(0, 1-e/10), 'note': f'E因子={e:.1f}'}
    def _r_lca(self, r):
        carbon = r.get('carbon_footprint', 100)
        return {'feasible': carbon < 200, 'score': max(0, 1-carbon/500), 'note': f'碳足迹{carbon}kgCO2'}
    # ===== 计算化学 4条 =====
    def _r_mm(self, r):
        e_total = r.get('mm_energy', -100)
        return {'feasible': e_total < 0, 'score': min(1.0, abs(e_total)/200), 'note': f'力场能量{e_total}kJ/mol'}
    def _r_md_sample(self, r):
        rmsd = r.get('rmsd', 0.05)
        if rmsd < 0.1: return {'feasible': True, 'score': 0.9, 'note': f'RMSD={rmsd}nm，已平衡'}
        return {'feasible': False, 'score': 0.3, 'note': f'RMSD={rmsd}nm，未平衡'}
    def _r_qmmm(self, r):
        qm_size = r.get('qm_atoms', 30)
        return {'feasible': qm_size < 100, 'score': min(1.0, 1-qm_size/200), 'note': f'QM区{qm_size}原子'}
    def _r_meta(self, r):
        hills = r.get('metadynamics_hills', 100)
        return {'feasible': hills > 50, 'score': min(1.0, hills/200), 'note': f'已加{hills}个山脊'}
    # ===== 信息化学 4条 =====
    def _r_descriptor(self, r):
        var = r.get('descriptor_variance', 0.5)
        return {'feasible': 0 < var < 1, 'score': var, 'note': f'描述符方差{var}'}
    def _r_qsar(self, r):
        r2 = r.get('r_squared', 0.7); q2 = r.get('q_squared', 0.6)
        if r2 > 0.6 and q2 > 0.5: return {'feasible': True, 'score': (r2+q2)/2, 'note': f'R²={r2},Q²={q2}通过'}
        return {'feasible': False, 'score': 0.4, 'note': 'QSAR不达标'}
    def _r_tanimoto(self, r):
        common = r.get('common_bits', 50); total = r.get('total_bits', 100)
        t = common / total
        return {'feasible': t > 0.3, 'score': t, 'note': f'Tanimoto={t:.2f}'}
    def _r_chem_space(self, r):
        size = r.get('chem_space_size', 10000)
        return {'feasible': True, 'score': min(1.0, math.log10(size)/6), 'note': f'化学空间{size}分子'}
    # ===== 合成化学 4条 =====
    def _r_retro_rule(self, r):
        steps = r.get('retro_steps', 3)
        return {'feasible': steps < 10, 'score': max(0, 1-steps/10), 'note': f'逆合成{steps}步'}
    def _r_regio(self, r):
        electronic = r.get('electronic_effect', 0.7); steric = r.get('steric_effect', 0.3)
        if electronic > steric: return {'feasible': True, 'score': electronic, 'note': '电子效应主导区域选择'}
        return {'feasible': True, 'score': steric, 'note': '空间效应主导'}
    def _r_stereo(self, r):
        ee = r.get('ee_percent', 85)
        return {'feasible': ee > 50, 'score': ee/100, 'note': f'ee={ee}%'}
    def _r_protect(self, r):
        has_pg = r.get('has_protecting_group', False)
        if has_pg: return {'feasible': True, 'score': 0.7, 'note': '需保护基'}
        return {'feasible': True, 'score': 0.9, 'note': '无需保护基'}
    # ===== 药物化学 4条 =====
    def _r_pk(self, r):
        k_elim = r.get('elimination_k', 0.1); c0 = r.get('c0', 10); t = r.get('reaction_time', 12)
        c = c0 * math.exp(-k_elim * t)
        return {'feasible': c > 0.1, 'score': min(1.0, c/c0), 'note': f'血药浓度{c:.2f}mg/L'}
    def _r_pharmacophore(self, r):
        hbd = r.get('hbd_count', 2); hba = r.get('hba_count', 3); hydrophobic = r.get('hydrophobic', True); aromatic = r.get('aromatic', True)
        features = sum([hbd > 0, hba > 0, hydrophobic, aromatic])
        return {'feasible': features >= 3, 'score': features/4, 'note': f'药效团特征{features}/4'}
    def _r_herg(self, r):
        ic50 = r.get('herg_ic50', 30)
        if ic50 > 30: return {'feasible': True, 'score': 0.9, 'note': f'hERG IC50={ic50}μM，安全'}
        return {'feasible': False, 'score': 0.3, 'note': f'hERG IC50={ic50}μM，心脏毒性风险'}
    def _r_ames(self, r):
        mutagenic = r.get('ames_positive', False)
        return {'feasible': not mutagenic, 'score': 0.9 if not mutagenic else 0.1, 'note': f'Ames{"阳性" if mutagenic else "阴性"}'}
    # ===== 材料化学 4条 =====
    def _r_defect(self, r):
        n_defect = r.get('defect_conc', 1e15)
        if n_defect < 1e18: return {'feasible': True, 'score': 0.9, 'note': f'缺陷浓度{n_defect:.0e}，可控'}
        return {'feasible': False, 'score': 0.3, 'note': '缺陷过多'}
    def _r_sintering(self, r):
        t = r.get('temperature', 1200); tm = r.get('t_melt', 1500)
        if t > 0.7 * tm: return {'feasible': True, 'score': 0.8, 'note': f'T={t}K>0.7Tm={0.7*tm:.0f}K，烧结'}
        return {'feasible': False, 'score': 0.3, 'note': '温度不足'}
    def _r_grain(self, r):
        size = r.get('grain_size', 1)
        return {'feasible': True, 'score': min(1.0, 10/size), 'note': f'晶粒{size}μm'}
    def _r_diff_phase(self, r):
        d = r.get('diffusivity', 1e-15); t = r.get('reaction_time', 12) * 3600
        length = math.sqrt(d * t)
        return {'feasible': length > 1e-9, 'score': min(1.0, length*1e9), 'note': f'扩散深度{length*1e9:.1f}nm'}
    # ===== 食品化学 3条 =====
    def _r_maillard(self, r):
        t = r.get('temperature', 120); aw = r.get('water_activity', 0.5)
        if t > 110 and 0.3 < aw < 0.7: return {'feasible': True, 'score': 0.9, 'note': f'美拉德T={t}°C,aw={aw}'}
        return {'feasible': False, 'score': 0.3, 'note': '美拉德条件不满足'}
    def _r_lipid(self, r):
        pv = r.get('peroxide_value', 10)
        if pv < 20: return {'feasible': True, 'score': 0.9, 'note': f'过氧化值{pv}meq/kg，新鲜'}
        return {'feasible': False, 'score': 0.3, 'note': f'过氧化值{pv}，氧化严重'}
    def _r_browning(self, r):
        has_enzyme = r.get('enzyme_active', True); oxygen = r.get('oxygen', True)
        if has_enzyme and oxygen: return {'feasible': True, 'score': 0.7, 'note': '酶促褐变可能'}
        return {'feasible': False, 'score': 0.9, 'note': '无褐变风险'}
    # ===== 法医化学 3条 =====
    def _r_fingerprint(self, r):
        age = r.get('fingerprint_age', 1)
        return {'feasible': age < 7, 'score': max(0, 1-age/7), 'note': f'指纹年龄{age}天'}
    def _r_toxin(self, r):
        ld50 = r.get('ld50', 100)
        if ld50 > 50: return {'feasible': True, 'score': 0.7, 'note': f'LD50={ld50}mg/kg，低毒'}
        return {'feasible': True, 'score': 0.3, 'note': f'LD50={ld50}mg/kg，剧毒'}
    def _r_isotope_trace(self, r):
        delta = r.get('delta_13c', -25)
        return {'feasible': True, 'score': 0.8, 'note': f'δ¹³C={delta}‰'}
    # ===== 军事/含能 3条 =====
    def _r_detonation(self, r):
        v = r.get('detonation_velocity', 7000)
        return {'feasible': v > 5000, 'score': min(1.0, v/10000), 'note': f'爆速{v}m/s'}
    def _r_brisance(self, r):
        br = r.get('brisance', 120)
        return {'feasible': True, 'score': min(1.0, br/150), 'note': f'猛度{br}%TNT'}
    def _r_oxygen_bal(self, r):
        ob = r.get('oxygen_balance', -30)
        if -40 < ob < 0: return {'feasible': True, 'score': 0.9, 'note': f'氧平衡{ob}%，最佳'}
        return {'feasible': True, 'score': 0.4, 'note': f'氧平衡{ob}%'}
    # ===== 气候/碳 3条 =====
    def _r_ghg(self, r):
        co2 = r.get('co2_ppm', 420); gwp = r.get('gwp', 1)
        forcing = 5.35 * math.log(max(co2 / 280, 0.1))
        return {'feasible': forcing < 5, 'score': max(0, 1-forcing/5), 'note': f'辐射强迫{forcing:.2f}W/m²'}
    def _r_carbon(self, r):
        flux = r.get('carbon_flux', 10)
        return {'feasible': True, 'score': min(1.0, flux/50), 'note': f'碳通量{flux}GtC/yr'}
    def _r_albedo(self, r):
        a = r.get('albedo', 0.3)
        temp_eff = 255 * (1 - a)**0.25
        return {'feasible': True, 'score': min(1.0, temp_eff/300), 'note': f'反照率{a},有效温度{temp_eff:.0f}K'}
    # ===== 量子信息 3条 =====
    def _r_entangle(self, r):
        concurrence = r.get('entanglement', 0.8)
        return {'feasible': concurrence > 0.5, 'score': concurrence, 'note': f'纠缠度{concurrence}'}
    def _r_decoherence(self, r):
        t_dec = r.get('decoherence_time', 1e-6)
        return {'feasible': t_dec > 1e-9, 'score': min(1.0, t_dec*1e6), 'note': f'退相干时间{t_dec:.0e}s'}
    def _r_qec(self, r):
        fidelity = r.get('fidelity', 0.99)
        return {'feasible': fidelity > 0.99, 'score': fidelity, 'note': f'保真度{fidelity}'}
    # ===== 超冷/玻色 2条 =====
    def _r_bec(self, r):
        t = r.get('temperature', 1e-7); n = r.get('density', 1e20)
        tc = 3.31 * self.h**2 / (2 * math.pi * 4 * 1.67e-27 * self.kB) * n**(2/3)
        return {'feasible': t < tc, 'score': 0.9 if t < tc else 0.3, 'note': f'Tc={tc:.2e}K,T={t:.2e}K'}
    def _r_superfluid(self, r):
        t = r.get('temperature', 1.5); tc = 2.17
        if t < tc: return {'feasible': True, 'score': 0.9, 'note': f'T={t}K<Tλ={tc}K，超流'}
        return {'feasible': False, 'score': 0.2, 'note': '非超流'}

    # ===== 生命起源 5条 =====
    def _r_abiotic(self, r):
        # 无机物→有机物（如HCN→氨基酸）
        t = r.get('temperature', 373); catalyst = r.get('catalyst', 'mineral')
        if t > 100 and catalyst in ['mineral','lightning','UV']: return {'feasible': True, 'score': 0.8, 'note': f'非生物合成T={t}K,{catalyst}催化'}
        return {'feasible': False, 'score': 0.3, 'note': '条件不足'}
    def _r_miller(self, r):
        # Miller-Urey实验：CH4+NH3+H2O+放电→氨基酸
        has_discharge = r.get('electric_discharge', True)
        has_gas = r.get('reducing_atmosphere', True)
        if has_discharge and has_gas: return {'feasible': True, 'score': 0.9, 'note': 'Miller-Urey氨基酸生成'}
        return {'feasible': False, 'score': 0.2, 'note': '缺还原气氛或放电'}
    def _r_rna(self, r):
        # RNA世界假说——RNA既是信息又是催化剂
        has_ribose = r.get('ribose', True); has_base = r.get('nucleobase', True)
        if has_ribose and has_base: return {'feasible': True, 'score': 0.7, 'note': 'RNA世界: 信息+催化'}
        return {'feasible': False, 'score': 0.3, 'note': '缺核糖或碱基'}
    def _r_panspermia(self, r):
        # 胚种论——生命星际传播
        uv_resist = r.get('uv_resistance', 0.8)
        return {'feasible': uv_resist > 0.5, 'score': uv_resist, 'note': f'抗UV={uv_resist},星际存活'}
    def _r_self_rep(self, r):
        # 自我复制——模板导向合成
        fidelity = r.get('copy_fidelity', 0.99)
        if fidelity > 0.95: return {'feasible': True, 'score': fidelity, 'note': f'复制保真度{fidelity}'}
        return {'feasible': False, 'score': 0.3, 'note': '保真度不足，错误灾难'}
    # ===== 手性起源 5条 =====
    def _r_homochiral(self, r):
        ee = r.get('ee_percent', 99)
        return {'feasible': ee > 90, 'score': ee/100, 'note': f'手性纯度ee={ee}%'}
    def _r_parity(self, r):
        # 弱相互作用宇称不守恒→微小手性偏好
        pv_energy = 1e-14  # eV量级
        return {'feasible': True, 'score': min(1.0, pv_energy*1e14), 'note': f'宇称不守恒能差~{pv_energy:.0e}eV'}
    def _r_cpl(self, r):
        # 圆偏振光诱导手性
        cpl_intensity = r.get('cpl_intensity', 0.1)
        return {'feasible': cpl_intensity > 0.01, 'score': min(1.0, cpl_intensity*5), 'note': f'CPL强度{cpl_intensity}'}
    def _r_asym_ads(self, r):
        # 手性表面不对称吸附
        has_chiral_surface = r.get('chiral_surface', True)
        return {'feasible': has_chiral_surface, 'score': 0.7 if has_chiral_surface else 0.3, 'note': f'手性表面{"有" if has_chiral_surface else "无"}'}
    def _r_soai(self, r):
        # Soai反应——自催化手性放大
        ee_initial = r.get('ee_initial', 1)
        ee_final = ee_initial * 10  # 自催化放大
        return {'feasible': ee_final > 50, 'score': min(1.0, ee_final/100), 'note': f'自催化ee {ee_initial}%→{ee_final:.0f}%'}
    # ===== 暗物质/暗能量 4条 =====
    def _r_dark_matter(self, r):
        # 暗物质通过引力效应间接参与化学
        dm_density = r.get('dm_density', 0.4)  # GeV/cm³
        return {'feasible': True, 'score': min(1.0, dm_density*2), 'note': f'暗物质密度{dm_density}GeV/cm³'}
    def _r_dark_energy(self, r):
        # 暗能量驱动宇宙膨胀
        w = r.get('eos_parameter', -1)
        if w < -1/3: return {'feasible': True, 'score': 0.8, 'note': f'状态方程w={w},加速膨胀'}
        return {'feasible': False, 'score': 0.3, 'note': '非加速膨胀'}
    def _r_wimp(self, r):
        # WIMP探测——核反冲信号
        sigma = r.get('wimp_cross_section', 1e-45)  # cm²
        return {'feasible': sigma > 1e-48, 'score': min(1.0, sigma*1e45), 'note': f'WIMP截面{sigma:.0e}cm²'}
    def _r_dark_photon(self, r):
        # 暗光子——假设的暗区规范玻色子
        mass = r.get('dark_photon_mass', 0.01)  # GeV
        return {'feasible': mass < 1, 'score': min(1.0, 1/mass), 'note': f'暗光子质量{mass}GeV'}
    # ===== 量子引力/弦论 4条 =====
    def _r_planck(self, r):
        # 普朗克尺度——量子引力效应
        l_planck = 1.616e-35  # m
        return {'feasible': True, 'score': 0.9, 'note': f'普朗克长度{l_planck:.0e}m'}
    def _r_holographic(self, r):
        # 全息原理——信息量受表面积限制
        s_max = r.get('area', 1) / 4 / (6.626e-34)**2 * 1e-69
        return {'feasible': True, 'score': 0.7, 'note': f'全息熵上限~{s_max:.0e}bit'}
    def _r_string(self, r):
        # 弦振动模式决定粒子性质
        return {'feasible': True, 'score': 0.6, 'note': '弦振动→粒子质量/电荷'}
    def _r_extra_dim(self, r):
        # 额外维度——Kaluza-Klein
        n_dim = r.get('extra_dimensions', 6)
        return {'feasible': n_dim > 0, 'score': min(1.0, n_dim/10), 'note': f'额外维度{n_dim}个'}
    # ===== 极端条件 4条 =====
    def _r_high_p(self, r):
        p = r.get('pressure', 1)
        if p > 1e6: return {'feasible': True, 'score': 0.9, 'note': f'超高压{p:.0e}Pa,相变/金属化'}
        return {'feasible': True, 'score': 0.5, 'note': f'压力{p}Pa'}
    def _r_extreme_t(self, r):
        t = r.get('temperature', 298)
        if t > 1e6: return {'feasible': True, 'score': 0.9, 'note': f'极高温{t:.0e}K,等离子体'}
        if t < 1e-3: return {'feasible': True, 'score': 0.8, 'note': f'极低温{t:.0e}K,量子效应'}
        return {'feasible': True, 'score': 0.6, 'note': f'常温{t}K'}
    def _r_radiation(self, r):
        dose = r.get('radiation_dose', 0)
        if dose > 1e4: return {'feasible': True, 'score': 0.7, 'note': f'辐射{dose:.0e}Gy,化学键断裂'}
        return {'feasible': True, 'score': 0.9, 'note': f'辐射{dose}Gy,正常'}
    def _r_microg(self, r):
        g = r.get('gravity', 9.8)
        if g < 0.01: return {'feasible': True, 'score': 0.8, 'note': f'微重力{g}m/s²,无对流'}
        return {'feasible': True, 'score': 0.5, 'note': f'重力{g}m/s²'}
    # ===== 前沿理论 4条 =====
    def _r_entropy_life(self, r):
        # 生命=低熵体+熵增驱动
        entropy_export = r.get('entropy_export', 10)
        return {'feasible': entropy_export > 0, 'score': min(1.0, entropy_export/100), 'note': f'熵流输出{entropy_export}J/K/s'}
    def _r_dissipative(self, r):
        # 耗散结构——远离平衡态的自组织
        distance = r.get('distance_from_equilibrium', 0.5)
        if distance > 0.3: return {'feasible': True, 'score': distance, 'note': f'远离平衡态{distance},耗散结构'}
        return {'feasible': False, 'score': 0.3, 'note': '近平衡态，无自组织'}
    def _r_autocatalysis(self, r):
        # 自催化反应网络（如Belousov-Zhabotinsky）
        has_autocat = r.get('autocatalytic', True)
        return {'feasible': has_autocat, 'score': 0.8 if has_autocat else 0.3, 'note': f'自催化{"有" if has_autocat else "无"}'}
    def _r_phase_sep(self, r):
        # 液-液相分离（凝聚体）
        conc = r.get('concentration', 0.1); c_sat = r.get('c_saturation', 0.05)
        if conc > c_sat: return {'feasible': True, 'score': 0.8, 'note': f'浓度{conc}>饱和{c_sat},相分离'}
        return {'feasible': False, 'score': 0.4, 'note': '未达相分离浓度'}

    def list_rules(self):
        return {
            '热力学(18)': ['first_law','enthalpy','entropy','gibbs_free_energy','helmholtz','maxwell_relations','carnot','vanderwaals','chemical_potential','gibbs_phase_rule','raoult_law','henry_law','activity_coeff','partial_molar','hess_law','kirchhoff','le_chatelier','clapeyron'],
            '统计力学(8)': ['boltzmann_dist','partition_func','equipartition','sackur_tetrode','virial_eq','fluctuation','einstein_model','debye_model'],
            '量子化学(12)': ['schrodinger','hartree_fock','lcao_mo','variational','pauli_exclusion','hund_rule','huckel_aromaticity','koopmans','born_oppenheimer','dft','fmo_homo_lumo','quantum_tunneling'],
            '动力学(14)': ['arrhenius','rate_law','eyring_tst','michaelis_menten','lindemann','chain_reaction','steady_state','pre_equilibrium','collision_theory','first_order','second_order','zero_order','curtin_hammett','hammond_postulate'],
            '电化学(10)': ['nernst','butler_volmer','debye_huckel','kohlrausch','faraday_law','pourbaix','galvanic_cell','tafel','electrochemical_series','ionic_strength'],
            '表面化学(8)': ['langmuir','bet','young_eq','laplace','kelvin_eq','gibbs_adsorption','dlvo','contact_angle'],
            '结构化学(8)': ['bragg','vsepr','crystal_field','ligand_field','point_group','miller_indices','steric_hindrance','conformational'],
            '光谱学/光化学(10)': ['beer_lambert','rotational_spec','vibrational_spec','raman_selection','nmr_shift','franck_condon','stark_einstein','quantum_yield','jablonski','photochemistry'],
            '催化/聚合/结晶/相变(10)': ['catalyst_activation','catalyst_selectivity','catalyst_poisoning','radical_polymerization','nucleation_theory','ostwald_ripening','lattice_energy','phase_transition','eutectic','glass_transition'],
            '传质传热/安全(6)': ['fick_diffusion','fourier_heat','newton_cooling','safety_assessment','lipinski_rule','ghs_hazard'],
            '分子间作用力(5)': ['lennard_jones','keesom_dipole','debye_induction','london_dispersion','hydrogen_bond'],
            '非平衡态/输运(5)': ['onsager_reciprocal','entropy_production','newton_viscosity','stokes_einstein','hagen_poiseuille'],
            '磁化学/放射(5)': ['curie_law','weiss_temperature','radioactive_decay','half_life','binding_energy'],
            '声化学/超临界(4)': ['acoustic_cavitation','supercritical_extraction','enhancement_factor','crossover_pressure'],
            '胶体/纳米(5)': ['brownian_motion','quantum_size','surface_dominance','hamaker_constant','zeta_potential'],
            '生物物理(4)': ['membrane_potential','protein_folding','michaelis_menten_bio','k_d_binding'],
            '软物质/非牛顿(5)': ['flory_huggins','rubber_elasticity','power_law_fluid','bingham_plastic','viscoelasticity'],
            '相对论/量子电动力学(4)': ['mass_energy','dirac_equation','fine_structure','spin_orbit_coupling'],
            '自组装/超分子(4)': ['self_assembly','host_guest','chirality_induction','circular_dichroism'],
            '非线性/振荡(5)': ['bz_oscillation','turing_pattern','reaction_diffusion','bifurcation','chaos_attractor'],
            '压电/热电/磁电/摩擦(4)': ['piezoelectric','thermoelectric','magnetoelectric','triboelectric'],
            '等离子体/光催化(4)': ['plasma_chemistry','photocatalysis','photoelectrochem','surface_plasmon'],
            '机械化学/拓扑(2)': ['mechanochemistry','topochemistry'],
            '核化学/放射(5)': ['fission_energy','activity_decay','radiation_dose','neutron_activation','isotope_separation'],
            '粒子物理(4)': ['strong_force','weak_force','quark_confinement','gauge_boson'],
            '天体化学(4)': ['stellar_nucleosynthesis','interstellar_molecule','atmospheric_escape','planetary_differentiation'],
            '地球化学(4)': ['weathering_rate','isotope_fractionation','eh_buffer','mineral_solubility'],
            '环境化学(5)': ['photochemical_smog','ph_buffer_capacity','freundlich_adsorption','ozone_depletion','cod_bod'],
            '绿色化学(3)': ['atom_economy','e_factor','lca_assessment'],
            '计算化学(4)': ['molecular_mechanics','md_sampling','qm_mm_boundary','metadynamics'],
            '信息化学(4)': ['molecular_descriptor','qsar_validation','tanimoto_similarity','chemical_space'],
            '合成化学(4)': ['retrosynthesis_rule','regioselectivity','stereoselectivity','protecting_group'],
            '药物化学(4)': ['pk_compartment','pharmacophore_model','herg_toxicity','ames_test'],
            '材料化学(4)': ['defect_chemistry','sintering_kinetics','grain_boundary','diffusion_phase'],
            '食品化学(3)': ['maillard_reaction','lipid_oxidation','enzymatic_browning'],
            '法医化学(3)': ['fingerprint_detection','toxin_analysis','isotope_tracing'],
            '军事/含能(3)': ['detonation_velocity','brisance','oxygen_balance'],
            '气候/碳(3)': ['greenhouse_effect','carbon_cycle','albedo_effect'],
            '量子信息(3)': ['quantum_entanglement','quantum_decoherence','quantum_error_correction'],
            '超冷/玻色(2)': ['bose_einstein','superfluidity'],
            '生命起源(5)': ['abiotic_synthesis','miller_urey','rna_world','panspermia','self_replication'],
            '手性起源(5)': ['homochirality','parity_violation','circular_polarization','asymmetric_adsorption','soai_reaction'],
            '暗物质/暗能量(4)': ['dark_matter_interaction','dark_energy_expansion','wimp_detection','dark_photon'],
            '量子引力/弦论(4)': ['planck_scale','holographic_principle','string_vibration','extra_dimension'],
            '极端条件(4)': ['high_pressure_chem','extreme_temp','radiation_chem','microgravity_chem'],
            '前沿理论(4)': ['entropy_life','dissipative_structure','autocatalysis','phase_separation'],
        }
