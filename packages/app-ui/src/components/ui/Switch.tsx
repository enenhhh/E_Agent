interface SwitchProps {
  checked: boolean;
  label: string;
  description?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export function Switch({
  checked,
  description,
  disabled = false,
  label,
  onChange,
}: SwitchProps): React.JSX.Element {
  return (
    <label className="switch-row">
      <span className="switch-row__copy">
        <span className="switch-row__label">{label}</span>
        {description ? <span className="switch-row__description">{description}</span> : null}
      </span>
      <input
        checked={checked}
        className="switch-row__input"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span aria-hidden className="switch-row__track">
        <span className="switch-row__thumb" />
      </span>
    </label>
  );
}
