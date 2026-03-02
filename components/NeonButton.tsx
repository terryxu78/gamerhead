
import React from 'react';

interface NeonButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  isLoading?: boolean;
}

const NeonButton: React.FC<NeonButtonProps> = ({ 
  children, 
  variant = 'primary', 
  isLoading, 
  className = '', 
  ...props 
}) => {
  const baseStyle = "relative inline-flex items-center justify-center px-6 py-2.5 font-medium rounded-full focus:outline-none transition-all duration-200 text-sm tracking-wide";
  
  const variants = {
    // Dark mode: Blue background, black text is often higher contrast, but white text on dark blue works too.
    // Google Material Dark usually keeps white text on accent buttons.
    primary: "text-gray-900 bg-google-blue hover:bg-google-blueHover shadow-md hover:shadow-lg active:shadow-sm",
    // Secondary: Outline or dark surface
    secondary: "text-google-blue bg-transparent border border-gray-600 hover:border-gray-400 hover:bg-white/5 shadow-sm hover:shadow-md",
    danger: "text-gray-900 bg-google-red hover:bg-[#F6AEA9] shadow-md hover:shadow-lg"
  };

  return (
    <button 
      className={`${baseStyle} ${variants[variant]} ${isLoading ? 'opacity-70 cursor-not-allowed' : ''} ${className}`}
      disabled={isLoading || props.disabled}
      {...props}
    >
      {isLoading ? (
        <span className="flex items-center gap-2">
          <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          Processing
        </span>
      ) : children}
    </button>
  );
};

export default NeonButton;
